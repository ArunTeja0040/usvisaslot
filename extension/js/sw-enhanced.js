// Enhanced service worker — adds CAPTCHA solving + auto-submit setting
// Runs alongside original sw.js logic

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.storage.local.get(
    ["is_display-slots", "is_sel-1st-slot", "is_auto-login", "is_auto-submit", "captchaMode"],
    function (t) {
      chrome.storage.local.set(
        {
          extVersion: chrome.runtime.getManifest().version,
          "is_display-slots": t["is_display-slots"] ?? true,
          "is_sel-1st-slot": t["is_sel-1st-slot"] ?? true,
          "is_auto-login": t["is_auto-login"] ?? true,
          "is_auto-submit": t["is_auto-submit"] ?? false,
          "is_auto-dashboard": t["is_auto-dashboard"] ?? true,
          captchaMode: t["captchaMode"] ?? "manual",
        },
        function () {
          if ("install" === reason)
            chrome.tabs.create({ url: "options.html" });
        }
      );

      chrome.scripting
        .registerContentScripts([
          {
            id: "usvisascheduling",
            js: ["js/page.js"],
            matches: ["https://www.usvisascheduling.com/*/*schedule/*"],
            runAt: "document_start",
            world: "MAIN",
          },
        ])
        .catch(console.log);
    }
  );
});

chrome.runtime.onMessageExternal.addListener((e, t, s) => {
  if (e) {
    if (e.message && "version" === e.message)
      s({ version: chrome.runtime.getManifest().version });
    else if (e.apiKey) chrome.storage.local.set({ apiKey: e.apiKey });
  }
  return true;
});

chrome.action.onClicked.addListener((tab) => {
  chrome.runtime.openOptionsPage();
});

// CAPTCHA solving via offscreen canvas in service worker
async function solveCaptchaLocal(base64Image) {
  try {
    const resp = await fetch("data:image/png;base64," + base64Image);
    const blob = await resp.blob();
    const bitmap = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;

    // Simple preprocessing: convert to grayscale, threshold
    for (let i = 0; i < data.length; i += 4) {
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const bw = gray > 128 ? 255 : 0;
      data[i] = data[i + 1] = data[i + 2] = bw;
    }
    ctx.putImageData(imageData, 0, 0);

    // For now, return null — actual OCR needs Tesseract.js or external API
    // The content script will fall back to manual mode
    return null;
  } catch (e) {
    console.log("CAPTCHA local solve error:", e);
    return null;
  }
}

function getAppointmentConfirmation() {
  return fetch("https://www.usvisascheduling.com/en-US/appointment-confirmation/")
    .then((e) => e.text())
    .then((e) => e);
}

function randomFileName(len = 5) {
  return (
    Array.from({ length: len }, () =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".charAt(
        Math.floor(62 * Math.random())
      )
    ).join("") + ".png"
  );
}

function flattenScheduleDays(e) {
  return e.length ? e.reduce((acc, t) => ((acc[t.ID] = t.Date), acc), {}) : {};
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // CAPTCHA solving request from content script
  if (msg.action === "solveCaptcha") {
    (async () => {
      try {
        const resp = await fetch("http://localhost:5123/solve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image: msg.imageBase64 }),
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.text) {
            console.log("CAPTCHA solved:", data.text);
            sendResponse({ text: data.text });
            return;
          }
        }
      } catch (e) {
        console.log("Local CAPTCHA server error:", e);
      }
      sendResponse({ text: null });
    })();
    return true;
  }

  // Get appointment confirmation
  if (msg.action === "getApntConfDets") {
    (async () => {
      try {
        const html = await getAppointmentConfirmation();
        sendResponse({ apntConfDets: html });
      } catch (e) {
        console.log("getApntConfDets error:", e);
        sendResponse({ apntConfDets: null });
      }
    })();
    return true;
  }

  // Appointment confirmation push
  if (msg.resource === "/push/appointment-confirmation") {
    chrome.storage.local.get(["apiKey", "extVersion"], function (settings) {
      const formData = new FormData();
      ["apntDetails", "userDetails", "capturedAt"].forEach((key) => {
        if (msg.hasOwnProperty(key)) {
          const val = msg[key];
          formData.append(
            key,
            typeof val === "object" && val !== null ? JSON.stringify(val) : val
          );
        }
      });

      fetch("https://app.checkvisaslots.com" + msg.resource, {
        headers: {
          "x-api-key": settings.apiKey,
          extVersion: settings.extVersion,
        },
        method: "POST",
        body: formData,
      })
        .then(() => sendResponse({ success: true }))
        .catch((e) => {
          console.log("Error sending appointment confirmation:", e);
          sendResponse({ success: false, error: e });
        });
    });
    return true;
  }

  // Slot data push (existing functionality)
  if (msg.resource && msg.imgUri && msg.portal_id) {
    const queryString = sender?.tab?.url?.split("?")[1] ?? null;
    chrome.storage.local.get(
      ["apiKey", "userProfiles", "extVersion", "sn_uid_valid"],
      function (settings) {
        try {
          let slotPage = msg.slot_page;
          let profile = JSON.parse(settings.userProfiles)[msg.portal_id];
          let [header, b64data] = msg.imgUri.split(",");
          let decoded = atob(b64data);
          let bytes = Array.from({ length: decoded.length }).map((_, i) =>
            decoded.charCodeAt(i)
          );
          let filename = randomFileName();
          let formData = new FormData();

          formData.append(
            "input",
            new Blob([new Uint8Array(bytes)], { type: "image/png" }),
            filename
          );

          if (profile.hasOwnProperty("VisaClass")) {
            let visaDets = { VisaClass: profile.VisaClass };
            if (profile.VisaClassID) visaDets.VisaClassID = profile.VisaClassID;
            if (profile.visaPriority)
              visaDets.visaPriority = profile.visaPriority;
            formData.append("visaDetails", JSON.stringify(visaDets));
          } else {
            formData.append("visaDetails", profile.visaDetails);
          }

          formData.append("userDetails", profile.userDetails);
          formData.append(
            "apntDetails",
            JSON.stringify(profile.apntDetails)
          );
          formData.append("applicants", profile.applicantsCount);
          formData.append(
            "slotDetails",
            JSON.stringify(slotPage.slotDetails)
          );
          formData.append(
            "appointmentTimes",
            JSON.stringify(slotPage.appointmentTimes)
          );
          formData.append("visaCountry", profile?.visaCountry);
          formData.append("slotLocationVal", slotPage.slotLocationVal);
          if (queryString) formData.append("pageUri", queryString);
          if (
            slotPage.hasOwnProperty("slotdetails") &&
            settings.sn_uid_valid
          ) {
            formData.append(
              "slotdetails",
              btoa(
                JSON.stringify(flattenScheduleDays(slotPage.slotdetails)).replaceAll(
                  "T00:00:00",
                  ""
                )
              )
            );
          }

          fetch("https://app.checkvisaslots.com" + msg.resource, {
            headers: {
              "x-api-key": settings.apiKey,
              extVersion: settings.extVersion,
            },
            method: "POST",
            body: formData,
          }).catch((e) => console.log(e));
        } catch (e) {
          console.log("Slot push error:", e);
        }
      }
    );
  }

  return true;
});
