from __future__ import annotations

import html as html_lib
import httpx
from config import TELEGRAM_BOT_TOKEN

_API_BASE = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}"


def send_message(text: str, chat_id: str = "") -> bool:
    if not chat_id:
        return False
    try:
        resp = httpx.post(
            f"{_API_BASE}/sendMessage",
            json={
                "chat_id": chat_id,
                "text": text,
                "parse_mode": "HTML",
            },
            timeout=15,
        )
        resp.raise_for_status()
        return True
    except Exception as e:
        print(f"[Telegram] Failed to send message: {e}")
        return False


def send_photo(photo_path: str, chat_id: str, caption: str = "") -> bool:
    if not chat_id:
        return False
    try:
        with open(photo_path, "rb") as f:
            resp = httpx.post(
                f"{_API_BASE}/sendPhoto",
                data={"chat_id": chat_id, "caption": caption},
                files={"photo": f},
                timeout=30,
            )
        resp.raise_for_status()
        return True
    except Exception as e:
        print(f"[Telegram] Failed to send photo: {e}")
        return False


def send_document(file_path: str, chat_id: str, caption: str = "") -> bool:
    if not chat_id:
        return False
    try:
        with open(file_path, "rb") as f:
            resp = httpx.post(
                f"{_API_BASE}/sendDocument",
                data={"chat_id": chat_id, "caption": caption},
                files={"document": f},
                timeout=60,
            )
        resp.raise_for_status()
        return True
    except Exception as e:
        print(f"[Telegram] Failed to send document: {e}")
        return False


def _e(text: str) -> str:
    return html_lib.escape(str(text))


def notify_bot_started(chat_id: str):
    send_message("🚀 <b>Visa Slot Bot started.</b> Monitoring for appointments...", chat_id)


def notify_bot_stopped(chat_id: str):
    send_message("🛑 <b>Visa Slot Bot stopped.</b>", chat_id)


def notify_login_start(user_name: str, chat_id: str):
    send_message(f"🔐 Logging in for <b>{_e(user_name)}</b>...", chat_id)


def notify_captcha_waiting(user_name: str, chat_id: str):
    send_message(f"🧩 Waiting for CAPTCHA solve for <b>{_e(user_name)}</b>...", chat_id)


def notify_security_questions(user_name: str, chat_id: str):
    send_message(f"🔑 Answering security questions for <b>{_e(user_name)}</b>...", chat_id)


def notify_login_success(user_name: str, chat_id: str):
    send_message(f"✅ <b>{_e(user_name)}</b> logged in successfully.", chat_id)


def notify_login_failed(user_name: str, reason: str, chat_id: str):
    send_message(f"❌ Login failed for <b>{_e(user_name)}</b>: {_e(reason)}", chat_id)


def notify_checking_ofc(user_name: str, consulate: str, chat_id: str):
    send_message(f"🔍 <b>{_e(user_name)}</b> — Checking OFC slots at <b>{_e(consulate)}</b>...", chat_id)


def notify_ofc_slot_found(user_name: str, consulate: str, date: str, time: str, chat_id: str):
    send_message(
        f"✅ <b>OFC SLOT FOUND!</b>\n\n"
        f"👤 {_e(user_name)}\n"
        f"📍 Consulate: <b>{_e(consulate)}</b>\n"
        f"📅 Date: <b>{_e(date)}</b>\n"
        f"🕐 Time: <b>{_e(time)}</b>\n\n"
        f"Booking OFC...",
        chat_id,
    )


def notify_ofc_booked(user_name: str, consulate: str, date: str, time: str, chat_id: str):
    send_message(
        f"🎉 <b>OFC BOOKED!</b>\n\n"
        f"👤 {_e(user_name)}\n"
        f"📍 {_e(consulate)}\n"
        f"📅 {_e(date)} at {_e(time)}\n\n"
        f"Now checking for interview slots...",
        chat_id,
    )


def notify_waiting_interview(user_name: str, minutes_left: int, chat_id: str):
    send_message(
        f"⏳ <b>{_e(user_name)}</b> — Interview dates not available yet. "
        f"Retrying for up to <b>{minutes_left} min</b>...",
        chat_id,
    )


def notify_interview_slot_found(user_name: str, consulate: str, date: str, time: str, chat_id: str):
    send_message(
        f"✅ <b>INTERVIEW SLOT FOUND!</b>\n\n"
        f"👤 {_e(user_name)}\n"
        f"📍 Consulate: <b>{_e(consulate)}</b>\n"
        f"📅 Date: <b>{_e(date)}</b>\n"
        f"🕐 Time: <b>{_e(time)}</b>\n\n"
        f"Booking interview...",
        chat_id,
    )


def notify_interview_booked(user_name: str, consulate: str, date: str, time: str, chat_id: str):
    send_message(
        f"🎉 <b>INTERVIEW BOOKED!</b>\n\n"
        f"👤 {_e(user_name)}\n"
        f"📍 {_e(consulate)}\n"
        f"📅 {_e(date)} at {_e(time)}",
        chat_id,
    )


def notify_booking_complete(user_name: str, chat_id: str, download_path: str = ""):
    send_message(
        f"🏆 <b>BOOKING COMPLETE for {_e(user_name)}!</b>\n\n"
        f"Both OFC and Interview are confirmed.",
        chat_id,
    )
    if download_path:
        send_document(download_path, chat_id, f"Confirmation document for {user_name}")


def notify_no_slots(user_name: str, consulate: str, chat_id: str):
    send_message(f"❌ <b>{_e(user_name)}</b> — No matching slots at <b>{_e(consulate)}</b>.", chat_id)


def notify_error(user_name: str, message: str, chat_id: str):
    send_message(f"🚨 <b>{_e(user_name)}</b> — Error: {_e(message)}", chat_id)


def notify_ofc_reset(user_name: str, chat_id: str):
    send_message(
        f"🔄 <b>{_e(user_name)}</b> — OFC became unblocked during interview wait. "
        f"Restarting from OFC booking...",
        chat_id,
    )
