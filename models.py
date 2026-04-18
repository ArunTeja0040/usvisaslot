from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date


@dataclass
class UserProfile:
    name: str
    username: str
    password: str
    security_questions: dict[str, str]
    preferred_consulates: list[str]
    date_range_start: date
    date_range_end: date
    telegram_chat_id: str

    @classmethod
    def from_dict(cls, data: dict) -> UserProfile:
        return cls(
            name=data["name"],
            username=data["username"],
            password=data["password"],
            security_questions=data["security_questions"],
            preferred_consulates=data["preferred_consulates"],
            date_range_start=date.fromisoformat(data["date_range_start"]),
            date_range_end=date.fromisoformat(data["date_range_end"]),
            telegram_chat_id=data.get("telegram_chat_id", ""),
        )


@dataclass
class BookingResult:
    user: UserProfile
    consulate: str
    ofc_date: str = ""
    ofc_time: str = ""
    ofc_confirmed: bool = False
    interview_date: str = ""
    interview_time: str = ""
    interview_confirmed: bool = False
    confirmation_downloaded: bool = False
    download_path: str = ""
