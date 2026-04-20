// Options page initialization — no access code required
(function () {
  "use strict";

  // ─── Security Questions Builder ──────────────────────────────────
  function addSecurityQuestion() {
    const count = document.getElementsByClassName("qna").length;
    if (count >= 3) return;

    const questions = [
      "Where did you meet your spouse?",
      "What is your sibling's middle name?",
      "Who was your childhood hero?",
      "In what city or town was your first job?",
      "What is the name of a college you applied to but didn't attend?",
      "What is the name of the road/street you grew up on?",
      "What is your least favorite food?",
      "What was the first company that you worked for?",
      "What is your favorite food?",
      "What high school did you attend?",
      "What is your mother's maiden name?",
      "What was the name of your first/current/favorite pet?",
      "What was your first car?",
      "What elementary school did you attend?",
      "What is the name of the town/city where you were born?",
    ];

    const optionsHTML = questions
      .map((q) => `<option value="${q}">${q}</option>`)
      .join("\n");

    const html = `<div class="qna">
      <div class="row mt-2">
        <label class="col-1 col-form-label">Q${count + 1}</label>
        <select class="form-control col-11 custom-select-sm question">
          <option value="">-- Select a question --</option>
          ${optionsHTML}
        </select>
        <div class="form-group form-control-sm form-inline" style="padding-left: 16px">
          <label for="answer">Ans:</label>
          <input type="text" class="form-control answer form-control-sm" name="answer" required>
        </div>
      </div>
    </div>`;

    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    document.querySelector("#security-questions").appendChild(wrapper.firstChild);
    addSecurityQuestion();
  }

  // ─── Location Dropdowns ──────────────────────────────────────────
  function buildLocationDropdowns() {
    const locations = {
      ofc: [
        "CHENNAI VAC",
        "HYDERABAD VAC",
        "KOLKATA VAC",
        "MUMBAI VAC",
        "NEW DELHI VAC",
      ],
      ca: ["CHENNAI", "HYDERABAD", "KOLKATA", "MUMBAI", "NEW DELHI"],
    };

    function buildSection(type) {
      const locs = locations[type];
      const optionsHTML =
        '<option value="">NONE</option>' +
        locs.map((l) => `<option value="${l}">${l}</option>`).join("\n");

      const container = document.getElementById(
        `preferred-${type}-location-container`
      );
      container.innerHTML = "";

      for (let i = 0; i < locs.length; i++) {
        container.innerHTML += `
          <div class="row mb-2 form-inline">
            <div class="col-4"><label>Priority ${i + 1}</label></div>
            <div class="col-8 form-group">
              <select class="form-control">${optionsHTML}</select>
            </div>
          </div>`;
      }
    }

    buildSection("ofc");
    buildSection("ca");
  }

  // ─── Load saved login details ────────────────────────────────────
  function loadLoginDetails() {
    document
      .querySelectorAll(".auto-login-container")
      .forEach((el) => (el.style.display = "flex"));

    chrome.storage.local.get(
      ["loginDetails", "securityQuestions"],
      function (data) {
        if (data && data.loginDetails) {
          document.getElementById("cvs-username").value =
            data.loginDetails.username || "";
          document.getElementById("cvs-password").value =
            data.loginDetails.password || "";
        }

        const questionEls = document.querySelectorAll(".question");
        const answerEls = document.querySelectorAll(".answer");

        if (data && data.securityQuestions) {
          Object.entries(data.securityQuestions).forEach(
            ([question, answer], idx) => {
              if (questionEls[idx]) questionEls[idx].value = question;
              if (answerEls[idx]) answerEls[idx].value = answer;
            }
          );
        }
      }
    );
  }

  // ─── Load saved preferences ──────────────────────────────────────
  function loadPreferences() {
    chrome.storage.local.get(
      ["preferred_locations", "preferred_window", "portal_id"],
      function (data) {
        if (data.portal_id) {
          document.getElementById("portal-id").value = data.portal_id;
        }

        if (data.preferred_window) {
          if (data.preferred_window.slot_start_date)
            document.getElementById("slot-start-date").value =
              data.preferred_window.slot_start_date;
          if (data.preferred_window.slot_end_date)
            document.getElementById("slot-end-date").value =
              data.preferred_window.slot_end_date;
        }

        if (data.preferred_locations) {
          const locs = data.preferred_locations;
          if (locs.ofc) {
            const selects = document.querySelectorAll(
              "#preferred-ofc-location-container select"
            );
            locs.ofc.forEach((val, i) => {
              if (selects[i]) selects[i].value = val;
            });
          }
          if (locs.ca) {
            const selects = document.querySelectorAll(
              "#preferred-ca-location-container select"
            );
            locs.ca.forEach((val, i) => {
              if (selects[i]) selects[i].value = val;
            });
          }
        }
      }
    );
  }

  // ─── Save handlers ──────────────────────────────────────────────
  function flashSaved(btnId, duration = 3) {
    const btn = document.getElementById(btnId);
    const original = btn.innerHTML;
    btn.innerHTML = "Saved!";
    btn.disabled = true;
    setTimeout(() => {
      btn.innerHTML = original;
      btn.disabled = false;
    }, duration * 1000);
  }

  // ─── Initialize ─────────────────────────────────────────────────
  addSecurityQuestion();
  buildLocationDropdowns();
  loadLoginDetails();
  loadPreferences();

  // Load toggle states
  chrome.storage.local.get(
    [
      "is_sel-1st-slot",
      "is_display-slots",
      "is_auto-login",
      "is_auto-submit",
      "is_auto-dashboard",
      "captchaMode",
    ],
    function (data) {
      document.getElementById("is_sel-1st-slot-btn").checked =
        data["is_sel-1st-slot"] ?? true;
      document.getElementById("is_display-slots-btn").checked =
        data["is_display-slots"] ?? true;
      document.getElementById("is_auto-login-btn").checked =
        data["is_auto-login"] ?? false;

      const submitBtn = document.getElementById("is_auto-submit-btn");
      if (submitBtn) submitBtn.checked = data["is_auto-submit"] ?? false;

      const dashBtn = document.getElementById("is_auto-dashboard-btn");
      if (dashBtn) dashBtn.checked = data["is_auto-dashboard"] ?? false;

      const mode = data["captchaMode"] || "manual";
      const radio = document.querySelector(
        `input[name="captchaMode"][value="${mode}"]`
      );
      if (radio) radio.checked = true;
    }
  );

  // Toggle change handlers (auto-save)
  document.querySelectorAll(".custom-control-input").forEach((el) => {
    el.addEventListener("change", function () {
      const key = this.id.replace("-btn", "");
      const obj = {};
      obj[key] = this.checked;
      chrome.storage.local.set(obj);
    });
  });

  // CAPTCHA mode radio handler
  document.querySelectorAll('input[name="captchaMode"]').forEach((radio) => {
    radio.addEventListener("change", function () {
      chrome.storage.local.set({ captchaMode: this.value });
    });
  });

  // Auto-login toggle
  document
    .getElementById("is_auto-login-btn")
    .addEventListener("change", function () {
      document
        .querySelectorAll(".auto-login-container")
        .forEach(
          (el) => (el.style.display = this.checked ? "flex" : "none")
        );
      if (this.checked) loadLoginDetails();
    });

  // Save login details
  document
    .getElementById("save-login-dets-btn")
    .addEventListener("click", function () {
      const loginDetails = {
        username: document.getElementById("cvs-username").value,
        password: document.getElementById("cvs-password").value,
      };

      const securityQuestions = {};
      const questionEls = document.querySelectorAll(".question");
      const answerEls = document.querySelectorAll(".answer");
      for (let i = 0; i < questionEls.length; i++) {
        if (questionEls[i].value && answerEls[i].value) {
          securityQuestions[questionEls[i].value] = answerEls[i].value;
        }
      }

      chrome.storage.local.set(
        { loginDetails, securityQuestions },
        function () {
          flashSaved("save-login-dets-btn");
        }
      );
    });

  // Save slot preferences
  document
    .getElementById("save-slot-preferences-btn")
    .addEventListener("click", function () {
      const preferred_window = {
        slot_start_date: document.getElementById("slot-start-date").value,
        slot_end_date: document.getElementById("slot-end-date").value,
      };

      const preferred_locations = { ofc: [], ca: [] };
      document
        .querySelectorAll("#preferred-ofc-location-container select")
        .forEach((el) => preferred_locations.ofc.push(el.value));
      document
        .querySelectorAll("#preferred-ca-location-container select")
        .forEach((el) => preferred_locations.ca.push(el.value));

      // Remove duplicates and empty values
      preferred_locations.ofc = [
        ...new Set(preferred_locations.ofc.filter(Boolean)),
      ];
      preferred_locations.ca = [
        ...new Set(preferred_locations.ca.filter(Boolean)),
      ];

      chrome.storage.local.set(
        {
          preferred_locations,
          preferred_window,
          portal_id: document.getElementById("portal-id").value,
        },
        function () {
          flashSaved("save-slot-preferences-btn");
        }
      );
    });
})();
