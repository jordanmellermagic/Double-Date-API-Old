from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
import requests
import os
import time
from zoneinfo import ZoneInfo
import secrets

app = FastAPI()

# ======================
# Constants
# ======================
MS_PER_DAY = 1000 * 60 * 60 * 24

ADMIN_LICENSE_CODE = os.getenv("ADMIN_LICENSE_CODE")
if not ADMIN_LICENSE_CODE:
    raise RuntimeError("ADMIN_LICENSE_CODE env var is required")

# ======================
# In-memory storage
# ======================
users = {}

# ======================
# Middleware
# ======================
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ======================
# Auth helpers
# ======================
def require_admin(request: Request):
    code = request.headers.get("x-admin-license")
    if code != ADMIN_LICENSE_CODE:
        raise HTTPException(status_code=403, detail="Invalid admin license")

def get_user_by_license(request: Request):
    license_code = request.headers.get("x-user-license")
    if not license_code:
        raise HTTPException(status_code=401, detail="Missing user license")

    for user in users.values():
        if user["user_license"] == license_code:
            return user

    raise HTTPException(status_code=403, detail="Invalid user license")

# ======================
# Goo
# ======================
def build_goo_url(goo_user_id: str) -> str:
    return f"https://11q.co/api/last/{goo_user_id}"

# ======================
# Manual date helpers
# ======================
def is_leap(year: int) -> bool:
    return year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)

def days_in_month(year: int, month: int) -> int:
    table = [31, 28 + is_leap(year), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    return table[month - 1]

def days_since_epoch(year: int, month: int, day: int) -> int:
    days = 0
    for y in range(1970, year):
        days += 366 if is_leap(y) else 365
    for m in range(1, month):
        days += days_in_month(year, m)
    days += day - 1
    return days

def now_ms_in_timezone(tz_name: str) -> int:
    tz = ZoneInfo(tz_name)
    return int((time.time() + tz.utcoffset(None).total_seconds()) * 1000)

def birth_midnight_ms(year: int, month: int, day: int, tz_name: str) -> int:
    tz = ZoneInfo(tz_name)
    days = days_since_epoch(year, month, day)
    epoch_midnight_ms = days * MS_PER_DAY
    offset_ms = int(tz.utcoffset(None).total_seconds() * 1000)
    return epoch_midnight_ms - offset_ms

def calculate_days_lived(year: int, month: int, day: int, tz_name: str) -> int:
    now_ms = now_ms_in_timezone(tz_name)
    birth_ms = birth_midnight_ms(year, month, day, tz_name)
    return (now_ms - birth_ms) // MS_PER_DAY

def calculate_weekday(year: int, month: int, day: int) -> str:
    names = ["Thursday", "Friday", "Saturday", "Sunday", "Monday", "Tuesday", "Wednesday"]
    return names[days_since_epoch(year, month, day) % 7]

# ======================
# OpenAI
# ======================
def extract_date(openai_key: str, sentence: str, locale: str):
    rules = "MM/DD/YYYY" if locale == "US" else "DD/MM/YYYY"

    prompt = f"""
Extract the date from the text.
Interpret numeric dates as {rules}.
Output ONLY YYYY-MM-DD or null.

Text: "{sentence}"
""".strip()

    r = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers={
            "Authorization": f"Bearer {openai_key}",
            "Content-Type": "application/json",
        },
        json={
            "model": "gpt-4o-mini",
            "temperature": 0,
            "messages": [
                {"role": "system", "content": "You are a strict date extractor."},
                {"role": "user", "content": prompt},
            ],
        },
        timeout=15,
    )

    if not r.ok:
        return None

    content = r.json()["choices"][0]["message"]["content"].strip()
    if content.lower() == "null":
        return None

    return content if len(content) == 10 else None

# ======================
# Routes
# ======================
@app.get("/")
def health():
    return {"status": "ok"}

@app.get("/admin", response_class=HTMLResponse)
def admin_page():
    try:
        with open("admin.html", "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return "<h1>Admin UI</h1>"

# ---------- Admin ----------
@app.post("/admin/users")
async def admin_create_user(request: Request):
    require_admin(request)
    data = await request.json()

    user_license = secrets.token_urlsafe(24)

    user = {
        "user_id": data["user_id"],
        "user_license": user_license,
        "goo_user_id": data["goo_user_id"],
        "openai_key": data["openai_key"],
        "timezone": data["timezone"],
        "locale": data.get("locale", "US"),
        "last_query": None,
        "last_result": None,
    }

    users[user["user_id"]] = user
    return {"user_id": user["user_id"], "user_license": user_license}

@app.get("/admin/users")
def admin_list_users(request: Request):
    require_admin(request)
    return users

@app.delete("/admin/users/{user_id}")
def admin_delete_user(user_id: str, request: Request):
    require_admin(request)
    users.pop(user_id, None)
    return {"ok": True}

# ---------- Processing ----------
@app.post("/process")
def process_user(request: Request):
    user = get_user_by_license(request)

    goo = requests.get(build_goo_url(user["goo_user_id"]), timeout=10)
    if not goo.ok:
        return {"updated": False}

    sentence = goo.json().get("query")
    if not sentence or sentence == user["last_query"]:
        return {"updated": False}

    date = extract_date(user["openai_key"], sentence, user["locale"])
    if not date:
        return {"updated": False}

    y, m, d = map(int, date.split("-"))

    days = calculate_days_lived(y, m, d, user["timezone"])
    weekday = calculate_weekday(y, m, d)

    user["last_query"] = sentence
    user["last_result"] = {
        "normalized_date": date,
        "daysLived": days,
        "weekday": weekday,
    }

    return {"updated": True}

# ---------- Hydra ----------
@app.get("/stats")
def stats(request: Request):
    user = get_user_by_license(request)
    if not user["last_result"]:
        return {"daysLived": None, "weekday": None}
    return user["last_result"]

# ---------- App ----------
@app.get("/user/me")
def get_user(request: Request):
    user = get_user_by_license(request)
    return {
        "goo_user_id": user["goo_user_id"],
        "timezone": user["timezone"],
        "locale": user["locale"],
    }

@app.patch("/user/me")
async def update_user(request: Request):
    user = get_user_by_license(request)
    data = await request.json()

    for key in ["goo_user_id", "timezone", "locale", "openai_key"]:
        if key in data:
            user[key] = data[key]

    return {"ok": True}
