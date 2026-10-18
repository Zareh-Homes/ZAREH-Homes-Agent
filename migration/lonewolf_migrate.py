from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import unicodedata
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import pandas as pd
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.exc import DBAPIError, SQLAlchemyError

CENT = Decimal("0.01")
HUNDRED = Decimal("100")
NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "lone-wolf-migration/zareh-homes")
PREC_PHRASE = "personal real estate corporation"
HST_NUMBER = re.compile(r"^\d{9}RT\d{4}$")
EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
NULLS = {"", "n/a", "na", "null", "none", "nil", "-", "--", "nan", "#n/a"}
TRUST_DEADLINE_BUSINESS_DAYS = 5

ONTARIO_TAX = [
    (date(2010, 7, 1), Decimal("0.13"), "HST"),
    (date(2008, 1, 1), Decimal("0.05"), "GST"),
    (date(2006, 7, 1), Decimal("0.06"), "GST"),
    (date(1991, 1, 1), Decimal("0.07"), "GST"),
]

AGENT_COLUMNS: dict[str, list[str]] = {
    "legacy_agent_id": ["agent id", "agentid", "agent_id", "member id", "agent number", "agent #", "agent no"],
    "first_name": ["first name", "firstname", "first", "given name"],
    "last_name": ["last name", "lastname", "last", "surname", "family name"],
    "full_name": ["agent name", "full name", "name", "agent"],
    "email": ["email", "email address", "agent email", "e mail", "e-mail"],
    "phone": ["phone", "cell", "mobile", "phone number", "cell phone"],
    "reco_number": ["reco #", "reco number", "reco registration", "reco registration #", "registration number", "reco"],
    "corp_flag": ["is corporation", "corporate account", "incorporated", "is prec", "prec", "pay to corporation", "corporation"],
    "corp_name": ["corporation name", "corporate name", "prec name", "prec legal name", "company name", "payable to", "pay to", "corporate account name"],
    "hst_number": ["hst #", "hst number", "gst/hst number", "gst/hst #", "hst registration", "hst registration #", "tax number", "business number"],
    "status": ["status", "agent status", "active"],
}

DEAL_COLUMNS: dict[str, list[str]] = {
    "legacy_deal_id": ["deal id", "dealid", "deal_id", "trade number", "trade #", "deal number", "deal #", "transaction id", "file number", "trade id"],
    "agent_id": ["agent id", "agentid", "agent_id", "member id", "agent number", "agent #", "agent no"],
    "side": ["side", "deal side", "end", "representation", "transaction type", "type"],
    "status": ["status", "deal status", "trade status"],
    "address": ["property address", "address", "street address"],
    "unit": ["unit", "suite", "unit #"],
    "city": ["city", "municipality", "town"],
    "province": ["province", "prov"],
    "mls": ["mls #", "mls number", "mls id", "mls", "listing number"],
    "sale_price": ["sale price", "selling price", "sold price", "price"],
    "offer_date": ["offer date", "accepted date", "acceptance date", "contract date", "date of agreement", "agreement date"],
    "firm_date": ["firm date", "conditions waived date", "unconditional date"],
    "close_date": ["close date", "closing date", "completion date", "closed date"],
    "deposit_amount": ["deposit amount", "deposit"],
    "deposit_holder": ["deposit held by", "deposit holder", "deposit held"],
    "commission_incl_tax": ["commission incl tax", "commission incl hst", "total commission", "gross commission incl tax", "commission including hst"],
    "base_gci": ["base gci", "gci", "gross commission income", "commission excl hst", "commission excl tax", "gross commission", "commission"],
    "tax": ["hst on gci", "hst", "tax", "hst on commission", "commission tax", "gst/hst"],
    "coop_commission": ["co-op commission", "coop commission", "cooperating commission", "co op commission"],
    "agent_split": ["agent split %", "agent split", "split %", "split"],
    "gci_share": ["gci share %", "agent share %", "share of gci", "gci share", "agent share"],
    "agent_gross": ["agent gross", "agent gross commission", "agent commission"],
    "agent_net": ["agent net", "net to agent", "agent payout", "net payout"],
    "sellers": ["seller", "sellers", "vendor", "vendors", "seller name"],
    "buyers": ["buyer", "buyers", "purchaser", "purchasers", "buyer name"],
}

TRUST_COLUMNS: dict[str, list[str]] = {
    "legacy_entry_id": ["entry id", "ledger id", "trust id", "trust entry id", "transaction id", "id"],
    "deal_id": ["deal id", "dealid", "deal_id", "trade number", "trade #", "deal number", "deal #", "file number", "trade id"],
    "entry_type": ["entry type", "type", "transaction type", "category"],
    "amount": ["amount", "value"],
    "credit": ["credit", "receipts", "deposit amount", "in"],
    "debit": ["debit", "payments", "disbursement amount", "out"],
    "date": ["date deposited", "deposit date", "posted date", "effective date", "transaction date", "date"],
    "received_date": ["date received", "received date", "received"],
    "method": ["method", "payment method", "instrument"],
    "counterparty": ["payor/payee", "payor", "payee", "received from", "paid to", "name"],
    "reference": ["bank reference", "reference", "ref", "cheque #", "cheque number", "wire reference"],
    "receipt_number": ["receipt #", "receipt number", "receipt no"],
    "account": ["trust account", "account", "account number"],
    "reverses": ["reverses entry id", "reversal of", "voids", "reverses"],
    "memo": ["memo", "notes", "description"],
}

REQUIRED = {
    "agents": [("legacy_agent_id",), ("email",), ("first_name", "full_name")],
    "deals": [("legacy_deal_id",), ("agent_id",), ("side",), ("status",), ("address",), ("sale_price",), ("close_date",), ("base_gci", "commission_incl_tax")],
    "trust": [("legacy_entry_id",), ("deal_id",), ("date",), ("amount", "credit")],
}

log = logging.getLogger("ontario_migration")


class StructuralError(Exception):
    pass


class RowError(Exception):
    pass


@dataclass
class Issue:
    source: str
    row_number: int
    key: str
    reason: str
    severity: str
    row: dict[str, Any]


@dataclass
class Ledger:
    issues: list[Issue] = field(default_factory=list)
    rejected: dict[str, list[tuple[int, dict[str, Any], str]]] = field(default_factory=dict)

    def warn(self, source: str, row_number: int, key: str, reason: str, row: dict[str, Any]) -> None:
        self._record(Issue(source, row_number, key, reason, "WARNING", row))

    def reject(self, source: str, row_number: int, key: str, reason: str, row: dict[str, Any]) -> None:
        self._record(Issue(source, row_number, key, reason, "ERROR", row))
        self.rejected.setdefault(source, []).append((row_number, row, reason))

    def _record(self, issue: Issue) -> None:
        self.issues.append(issue)
        payload = {
            "source": issue.source,
            "row_number": issue.row_number,
            "key": issue.key,
            "severity": issue.severity,
            "reason": issue.reason,
            "row": issue.row,
        }
        log.log(logging.ERROR if issue.severity == "ERROR" else logging.WARNING, json.dumps(payload, default=str, ensure_ascii=False))

    def count(self, source: str, severity: str) -> int:
        return sum(1 for i in self.issues if i.source == source and i.severity == severity)


def stable_id(kind: str, legacy: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f"{kind}:{legacy}"))


def clean_text(value: Any) -> str | None:
    if value is None:
        return None
    s = unicodedata.normalize("NFKC", str(value)).replace(" ", " ")
    s = re.sub(r"\s+", " ", s).strip()
    return None if s.lower() in NULLS else s


def norm_header(header: str) -> str:
    h = unicodedata.normalize("NFKC", header).replace("﻿", "").lower()
    h = h.replace("_", " ")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9#%/ -]+", " ", h)).strip()


def parse_money(value: Any, label: str, allow_negative: bool = False) -> Decimal | None:
    raw = clean_text(value)
    if raw is None:
        return None
    s = raw.upper().replace("CAD", "").replace("CA$", "").replace("C$", "").replace("$", "").replace(" ", "")
    negative = False
    if s.startswith("(") and s.endswith(")"):
        negative, s = True, s[1:-1]
    if s.endswith("-"):
        negative, s = True, s[:-1]
    if s.startswith("-"):
        negative, s = True, s[1:]
    if re.fullmatch(r"\d+,\d{1,2}", s):
        s = s.replace(",", ".")
    elif re.fullmatch(r"\d{1,3}(\.\d{3})+,\d{1,2}", s):
        s = s.replace(".", "").replace(",", ".")
    else:
        s = s.replace(",", "")
    if not re.fullmatch(r"\d+(\.\d+)?", s):
        raise RowError(f"{label}: '{raw}' is not a valid amount")
    try:
        amount = Decimal(s)
    except InvalidOperation as exc:
        raise RowError(f"{label}: '{raw}' is not a valid amount") from exc
    if negative:
        amount = -amount
    if amount < 0 and not allow_negative:
        raise RowError(f"{label}: '{raw}' is negative")
    return amount.quantize(CENT, rounding=ROUND_HALF_UP)


def parse_percent(value: Any, label: str) -> tuple[Decimal | None, str | None]:
    raw = clean_text(value)
    if raw is None:
        return None, None
    s = raw.replace(" ", "")
    had_sign = "%" in s
    s = s.replace("%", "")
    if re.fullmatch(r"\d+(\.\d+)?/\d+(\.\d+)?", s):
        s = s.split("/")[0]
    try:
        pct = Decimal(s.replace(",", "."))
    except InvalidOperation as exc:
        raise RowError(f"{label}: '{raw}' is not a percentage") from exc
    note = None
    if not had_sign and Decimal("0") < pct <= Decimal("1"):
        pct, note = pct * HUNDRED, f"{label}: '{raw}' read as a fraction ({pct * HUNDRED}%)"
    if pct < 0 or pct > HUNDRED:
        raise RowError(f"{label}: '{raw}' is outside 0–100%")
    return pct.quantize(CENT, rounding=ROUND_HALF_UP), note


MONTHS = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def _year(y: str) -> int:
    if len(y) == 4:
        return int(y)
    yy = int(y)
    pivot = (date.today().year + 1) % 100
    return 2000 + yy if yy <= pivot else 1900 + yy


def _build(y: int, m: int, d: int, raw: str, label: str) -> date:
    try:
        result = date(y, m, d)
    except ValueError as exc:
        raise RowError(f"{label}: '{raw}' is not a real date") from exc
    if not (date(1990, 1, 1) <= result <= date.today() + timedelta(days=3 * 365)):
        raise RowError(f"{label}: '{raw}' is outside the plausible range")
    return result


def parse_date(value: Any, label: str, slash_order: str = "DMY", dash_order: str = "MDY") -> tuple[date | None, str | None]:
    raw = clean_text(value)
    if raw is None:
        return None, None
    s = re.sub(r"[ T]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*(AM|PM|am|pm)?$", "", raw).strip()

    m = re.fullmatch(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", s)
    if m:
        return _build(int(m[1]), int(m[2]), int(m[3]), raw, label), None

    m = re.fullmatch(r"(\d{1,2})([/.-])(\d{1,2})\2(\d{2}|\d{4})", s)
    if m:
        a, sep, b, y = int(m[1]), m[2], int(m[3]), _year(m[4])
        order = dash_order if sep == "-" else slash_order
        first_is_day = order == "DMY"
        day, month = (a, b) if first_is_day else (b, a)
        if month > 12 and day <= 12:
            day, month = month, day
            note = f"{label}: '{raw}' only works as {'MM/DD' if first_is_day else 'DD/MM'}; read as {y:04d}-{month:02d}-{day:02d}"
            return _build(y, month, day, raw, label), note
        return _build(y, month, day, raw, label), None

    m = re.fullmatch(r"(\d{1,2})[ -]([A-Za-z]{3,9})\.?[ ,-]*(\d{2}|\d{4})", s)
    if m and m[2][:3].lower() in MONTHS:
        return _build(_year(m[3]), MONTHS[m[2][:3].lower()], int(m[1]), raw, label), None

    m = re.fullmatch(r"([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})", s)
    if m and m[1][:3].lower() in MONTHS:
        return _build(int(m[3]), MONTHS[m[1][:3].lower()], int(m[2]), raw, label), None

    if re.fullmatch(r"\d{5}", s) and 30000 <= int(s) <= 60000:
        result = date(1899, 12, 30) + timedelta(days=int(s))
        return _build(result.year, result.month, result.day, raw, label), f"{label}: '{raw}' read as an Excel date serial ({result.isoformat()})"

    raise RowError(f"{label}: '{raw}' is not a recognised date")


def parse_bool(value: Any) -> bool | None:
    raw = clean_text(value)
    if raw is None:
        return None
    s = raw.lower()
    if s in {"y", "yes", "true", "1", "x", "corporation", "corporate", "prec", "incorporated", "active"}:
        return True
    if s in {"n", "no", "false", "0", "individual", "inactive", "terminated"}:
        return False
    return None


def tax_rate(province: str | None, when: date) -> tuple[Decimal, str]:
    prov = (province or "ON").strip().upper()
    if prov not in {"ON", "ONT", "ONTARIO"}:
        raise RowError(f"province '{province}' isn't supported; only Ontario rates are loaded")
    for start, rate, name in ONTARIO_TAX:
        if when >= start:
            return rate, name
    raise RowError(f"no Ontario tax rate for {when.isoformat()}")


def reconcile_tax(base: Decimal | None, tax: Decimal | None, total: Decimal | None, rate: Decimal, tax_name: str) -> tuple[Decimal, Decimal, list[str]]:
    notes: list[str] = []
    pct = f"{(rate * HUNDRED).normalize()}% {tax_name}"
    if base is None and total is None:
        raise RowError("no commission amount (base GCI or commission incl. tax)")
    if base is not None and tax is not None:
        if total is not None and abs(base + tax - total) > CENT:
            raise RowError(f"base GCI {base} + tax {tax} doesn't equal the total commission {total}")
    elif base is not None and total is not None:
        tax = total - base
        notes.append(f"tax {tax} derived from total commission {total} − base GCI {base}")
    elif total is not None:
        base = (total / (1 + rate)).quantize(CENT, rounding=ROUND_HALF_UP)
        tax = total - base
        notes.append(f"base GCI {base} and tax {tax} backed out of combined commission {total} at {pct}")
    else:
        tax = (base * rate).quantize(CENT, rounding=ROUND_HALF_UP)
        notes.append(f"tax {tax} backfilled at {pct} of base GCI {base}")
    assert base is not None and tax is not None
    if base < 0 or tax < 0 or tax > base:
        raise RowError(f"commission figures don't make sense: base {base}, tax {tax}")
    expected = (base * rate).quantize(CENT, rounding=ROUND_HALF_UP)
    if abs(tax - expected) > CENT:
        notes.append(f"recorded tax {tax} is not {pct} of base GCI {base} (expected {expected}); kept as recorded, please review")
    return base, tax, notes


def business_days_between(start: date, end: date) -> int:
    days, d = 0, start
    while d < end:
        d += timedelta(days=1)
        if d.weekday() < 5:
            days += 1
    return days


def read_csv(path: Path, source: str) -> pd.DataFrame:
    if not path.exists():
        raise StructuralError(f"{source}: file not found: {path}")
    last_error: Exception | None = None
    for encoding in ("utf-8-sig", "cp1252", "latin-1"):
        try:
            df = pd.read_csv(path, dtype=str, keep_default_na=False, encoding=encoding, skip_blank_lines=True)
            break
        except UnicodeDecodeError as exc:
            last_error = exc
        except pd.errors.EmptyDataError as exc:
            raise StructuralError(f"{source}: {path} is empty") from exc
        except pd.errors.ParserError as exc:
            raise StructuralError(f"{source}: {path} is not a readable CSV ({exc})") from exc
    else:
        raise StructuralError(f"{source}: can't decode {path} ({last_error})")
    df = df.loc[~(df.apply(lambda r: all(clean_text(v) is None for v in r), axis=1))]
    if df.empty:
        raise StructuralError(f"{source}: {path} has no data rows")
    return df


def resolve_columns(df: pd.DataFrame, spec: dict[str, list[str]], source: str, overrides: dict[str, str]) -> dict[str, str | None]:
    headers = {norm_header(h): h for h in df.columns}
    if len(headers) != len(df.columns):
        raise StructuralError(f"{source}: duplicate column headers after normalisation: {list(df.columns)}")
    resolved: dict[str, str | None] = {}
    used: set[str] = set()
    for fld, aliases in spec.items():
        resolved[fld] = None
        if fld in overrides:
            if overrides[fld] not in df.columns:
                raise StructuralError(f"{source}: mapped column '{overrides[fld]}' for {fld} is not in the file")
            resolved[fld] = overrides[fld]
            used.add(overrides[fld])
            continue
        for alias in aliases:
            original = headers.get(norm_header(alias))
            if original is not None and original not in used:
                resolved[fld] = original
                used.add(original)
                break
    missing = [" or ".join(group) for group in REQUIRED[source] if not any(resolved.get(f) for f in group)]
    if missing:
        raise StructuralError(f"{source}: required column(s) not found: {', '.join(missing)}. Headers present: {list(df.columns)}")
    return resolved


def get(row: dict[str, Any], cols: dict[str, str | None], fld: str) -> Any:
    col = cols.get(fld)
    return row.get(col) if col else None


@dataclass
class Agent:
    legacy_id: str
    user_id: str
    email: str
    first_name: str
    last_name: str
    phone: str | None
    reco: str | None
    is_prec: bool
    prec_legal_name: str | None
    hst_number: str | None
    active: bool
    row_number: int
    row: dict[str, Any]


def transform_agents(df: pd.DataFrame, cols: dict[str, str | None], ledger: Ledger) -> dict[str, Agent]:
    agents: dict[str, Agent] = {}
    emails: set[str] = set()
    recos: set[str] = set()
    for idx, raw in enumerate(df.to_dict("records")):
        row_number = idx + 2
        key = clean_text(get(raw, cols, "legacy_agent_id")) or f"row {row_number}"
        try:
            legacy_id = clean_text(get(raw, cols, "legacy_agent_id"))
            if not legacy_id:
                raise RowError("agent ID is blank")
            if legacy_id in agents:
                raise RowError(f"duplicate agent ID {legacy_id} (first seen on row {agents[legacy_id].row_number})")
            email = (clean_text(get(raw, cols, "email")) or "").lower()
            if not EMAIL.fullmatch(email):
                raise RowError(f"email '{email}' is missing or invalid")
            if email in emails:
                raise RowError(f"email {email} is already used by another agent in this file")

            first, last = clean_text(get(raw, cols, "first_name")), clean_text(get(raw, cols, "last_name"))
            if not (first and last):
                full = clean_text(get(raw, cols, "full_name"))
                if not full:
                    raise RowError("agent name is missing")
                if "," in full:
                    last, first = [p.strip() for p in full.split(",", 1)]
                else:
                    parts = full.split(" ")
                    if len(parts) < 2:
                        raise RowError(f"can't split '{full}' into first and last name")
                    first, last = " ".join(parts[:-1]), parts[-1]

            corp_name = clean_text(get(raw, cols, "corp_name"))
            corp_flag = parse_bool(get(raw, cols, "corp_flag"))
            is_prec, prec_legal_name = False, None
            if corp_name:
                if PREC_PHRASE in corp_name.lower():
                    is_prec, prec_legal_name = True, corp_name
                else:
                    ledger.warn("agents", row_number, key,
                                f"corporate payee '{corp_name}' isn't named as a Personal Real Estate Corporation; imported as an individual (is_prec = false). Confirm before paying a corporation.", raw)
            elif corp_flag:
                ledger.warn("agents", row_number, key, "marked as a corporation but no corporation name is given; imported with is_prec = false", raw)

            hst_raw = clean_text(get(raw, cols, "hst_number"))
            hst = None
            if hst_raw:
                compact = re.sub(r"[\s-]", "", hst_raw).upper()
                if HST_NUMBER.fullmatch(compact):
                    hst = compact
                else:
                    ledger.warn("agents", row_number, key,
                                f"HST number '{hst_raw}' isn't in CRA format (9 digits + RT + 4 digits); left blank"
                                + (" — it looks like a business number without the RT account" if re.fullmatch(r"\d{9}", compact) else ""), raw)

            reco = clean_text(get(raw, cols, "reco_number"))
            if reco and reco in recos:
                ledger.warn("agents", row_number, key, f"RECO number {reco} is repeated in the file; left blank on this agent", raw)
                reco = None

            status = parse_bool(get(raw, cols, "status"))
            agent = Agent(
                legacy_id=legacy_id, user_id=stable_id("agent", legacy_id), email=email, first_name=first, last_name=last,
                phone=clean_text(get(raw, cols, "phone")), reco=reco, is_prec=is_prec, prec_legal_name=prec_legal_name,
                hst_number=hst, active=status is not False, row_number=row_number, row=raw,
            )
            agents[legacy_id] = agent
            emails.add(email)
            if reco:
                recos.add(reco)
        except RowError as exc:
            ledger.reject("agents", row_number, key, str(exc), raw)
    return agents


SIDES = {
    "listing": "LISTING", "list": "LISTING", "seller": "LISTING", "sell": "LISTING", "listing side": "LISTING", "vendor": "LISTING",
    "selling": "BUYER", "buyer": "BUYER", "buy": "BUYER", "co-op": "BUYER", "coop": "BUYER", "buyer side": "BUYER", "purchaser": "BUYER",
    "both": "DUAL", "dual": "DUAL", "double end": "DUAL", "double-end": "DUAL", "multiple representation": "DUAL",
    "landlord": "LANDLORD", "lease listing": "LANDLORD", "tenant": "TENANT", "lease": "TENANT",
}
STATUSES = {
    "closed": "CLOSED", "sold": "CLOSED", "complete": "CLOSED", "completed": "CLOSED", "paid": "CLOSED", "finalized": "CLOSED",
    "firm": "FIRM", "unconditional": "FIRM", "pending": "FIRM", "pending close": "FIRM",
    "conditional": "CONDITIONAL",
    "collapsed": "COLLAPSED", "fell through": "COLLAPSED", "terminated": "COLLAPSED",
    "cancelled": "CANCELLED", "canceled": "CANCELLED", "void": "CANCELLED",
}
HOLDERS = {
    "our brokerage": "OUR_BROKERAGE", "brokerage": "OUR_BROKERAGE", "us": "OUR_BROKERAGE", "in trust": "OUR_BROKERAGE", "listing brokerage": None,
    "co-op": "COOP_BROKERAGE", "coop": "COOP_BROKERAGE", "co-op brokerage": "COOP_BROKERAGE", "cooperating brokerage": "COOP_BROKERAGE",
    "lawyer": "LAWYER", "solicitor": "LAWYER", "builder": "BUILDER", "trustee": "BUILDER",
}


@dataclass
class DealAgent:
    user_legacy_id: str
    role: str
    split: Decimal
    share: Decimal
    gross: Decimal
    net: Decimal


@dataclass
class Deal:
    legacy_id: str
    deal_id: str
    deal_number: str
    side: str
    status: str
    address: str
    unit: str | None
    city: str
    mls: str | None
    sale_price: Decimal
    offer_date: date
    close_date: date
    deposit_amount: Decimal | None
    deposit_holder: str | None
    base_gci: Decimal
    hst: Decimal
    coop: Decimal
    agents: list[DealAgent]
    sellers: list[str]
    buyers: list[str]
    rows: list[tuple[int, dict[str, Any]]]


def _deal_fields(raw: dict[str, Any], cols: dict[str, str | None], row_number: int, key: str, ledger: Ledger, opts: argparse.Namespace) -> dict[str, Any]:
    def d(fld: str) -> date | None:
        value, note = parse_date(get(raw, cols, fld), fld.replace("_", " "), opts.slash_dates, opts.dash_dates)
        if note:
            ledger.warn("deals", row_number, key, note, raw)
        return value

    side_raw = (clean_text(get(raw, cols, "side")) or "").lower()
    side = SIDES.get(side_raw)
    if not side:
        raise RowError(f"deal side '{side_raw}' isn't recognised")
    status_raw = (clean_text(get(raw, cols, "status")) or "").lower()
    status = STATUSES.get(status_raw)
    if not status:
        raise RowError(f"deal status '{status_raw}' isn't recognised")

    address = clean_text(get(raw, cols, "address"))
    city = clean_text(get(raw, cols, "city"))
    if address and not city and "," in address:
        parts = [p.strip() for p in address.split(",")]
        address, city = parts[0], parts[1]
    if not address or not city:
        raise RowError("property address or city is missing")

    sale_price = parse_money(get(raw, cols, "sale_price"), "sale price")
    if not sale_price or sale_price <= 0:
        raise RowError("sale price is missing or zero")

    close_date = d("close_date")
    if close_date is None:
        raise RowError("closing date is missing")
    offer_date = d("offer_date") or d("firm_date")
    if offer_date is None:
        offer_date = close_date
        ledger.warn("deals", row_number, key, "offer date missing; closing date used in its place", raw)
    if close_date < offer_date:
        raise RowError(f"closing date {close_date} is before offer date {offer_date}")

    rate, tax_name = tax_rate(clean_text(get(raw, cols, "province")), close_date)
    base, hst, notes = reconcile_tax(
        parse_money(get(raw, cols, "base_gci"), "base GCI"),
        parse_money(get(raw, cols, "tax"), "tax"),
        parse_money(get(raw, cols, "commission_incl_tax"), "commission incl. tax"),
        rate, tax_name,
    )
    for note in notes:
        ledger.warn("deals", row_number, key, note, raw)

    coop = parse_money(get(raw, cols, "coop_commission"), "co-op commission") or Decimal("0.00")
    if coop > 0 and side != "LISTING":
        raise RowError(f"co-op commission {coop} on a {side} deal (only listing-side deals pay a co-op)")

    holder_raw = (clean_text(get(raw, cols, "deposit_holder")) or "").lower()
    holder = HOLDERS.get(holder_raw) if holder_raw else None
    if holder_raw and holder_raw not in HOLDERS:
        raise RowError(f"deposit holder '{holder_raw}' isn't recognised")

    mls = clean_text(get(raw, cols, "mls"))
    return {
        "side": side, "status": status, "address": address, "unit": clean_text(get(raw, cols, "unit")), "city": city,
        "mls": mls.upper().replace(" ", "") if mls else None, "sale_price": sale_price, "offer_date": offer_date,
        "close_date": close_date, "deposit_amount": parse_money(get(raw, cols, "deposit_amount"), "deposit amount"),
        "deposit_holder": holder, "base_gci": base, "hst": hst, "coop": coop,
    }


def transform_deals(df: pd.DataFrame, cols: dict[str, str | None], agents: dict[str, Agent], ledger: Ledger, opts: argparse.Namespace) -> dict[str, Deal]:
    groups: dict[str, list[tuple[int, dict[str, Any]]]] = {}
    for idx, raw in enumerate(df.to_dict("records")):
        row_number = idx + 2
        legacy = clean_text(get(raw, cols, "legacy_deal_id"))
        if not legacy:
            ledger.reject("deals", row_number, f"row {row_number}", "deal ID is blank", raw)
            continue
        groups.setdefault(legacy, []).append((row_number, raw))

    deals: dict[str, Deal] = {}
    compare = ("side", "status", "address", "city", "sale_price", "close_date", "base_gci", "hst", "coop")
    for legacy, rows in groups.items():
        try:
            base: dict[str, Any] | None = None
            deal_agents: list[DealAgent] = []
            shares_given: list[bool] = []
            sellers: list[str] = []
            buyers: list[str] = []
            for i, (row_number, raw) in enumerate(rows):
                fields = _deal_fields(raw, cols, row_number, legacy, ledger, opts)
                if base is None:
                    base = fields
                else:
                    diffs = [f for f in compare if fields[f] != base[f]]
                    if diffs:
                        raise RowError(f"rows for this deal disagree on: {', '.join(diffs)}")

                agent_legacy = clean_text(get(raw, cols, "agent_id"))
                if not agent_legacy:
                    raise RowError(f"row {row_number} has no agent ID")
                if agent_legacy not in agents:
                    raise RowError(f"agent ID {agent_legacy} on row {row_number} isn't in the agents export (or was rejected)")
                if any(a.user_legacy_id == agent_legacy for a in deal_agents):
                    raise RowError(f"agent {agent_legacy} appears twice on this deal")

                share, share_note = parse_percent(get(raw, cols, "gci_share"), "GCI share")
                shares_given.append(share is not None)
                split, split_note = parse_percent(get(raw, cols, "agent_split"), "agent split")
                gross = parse_money(get(raw, cols, "agent_gross"), "agent gross")
                net = parse_money(get(raw, cols, "agent_net"), "agent net")
                for note in (share_note, split_note):
                    if note:
                        ledger.warn("deals", row_number, legacy, note, raw)
                deal_agents.append(DealAgent(agent_legacy, "PRIMARY" if i == 0 else "CO_AGENT", split if split is not None else Decimal("-1"),
                                             share if share is not None else Decimal("0"), gross or Decimal("0.00"), net or Decimal("0.00")))
                for name in (clean_text(get(raw, cols, "sellers")) or "").split(";"):
                    if name.strip() and name.strip() not in sellers:
                        sellers.append(name.strip())
                for name in (clean_text(get(raw, cols, "buyers")) or "").split(";"):
                    if name.strip() and name.strip() not in buyers:
                        buyers.append(name.strip())
            assert base is not None

            if all(shares_given):
                total = sum(a.share for a in deal_agents)
                if abs(total - HUNDRED) > CENT:
                    raise RowError(f"agents' GCI shares add up to {total}%, not 100%")
            elif not any(shares_given):
                each = (HUNDRED / len(deal_agents)).quantize(CENT, rounding=ROUND_HALF_UP)
                for a in deal_agents:
                    a.share = each
                deal_agents[0].share += HUNDRED - each * len(deal_agents)
                if len(deal_agents) > 1:
                    ledger.warn("deals", rows[0][0], legacy, f"no GCI shares given for {len(deal_agents)} agents; split equally", rows[0][1])
            else:
                raise RowError("GCI share is given for some agents on this deal but not others")

            for a in deal_agents:
                if a.split < 0:
                    allocated = base["base_gci"] * a.share / HUNDRED
                    if a.gross > 0 and allocated > 0:
                        a.split = (a.gross / allocated * HUNDRED).quantize(CENT, rounding=ROUND_HALF_UP)
                        ledger.warn("deals", rows[0][0], legacy, f"agent {a.user_legacy_id} split derived from agent gross: {a.split}%", rows[0][1])
                        if a.split > HUNDRED:
                            raise RowError(f"agent {a.user_legacy_id} gross {a.gross} is more than their share of GCI")
                    else:
                        raise RowError(f"agent {a.user_legacy_id} has no split and no agent gross to derive it from")

            deals[legacy] = Deal(
                legacy_id=legacy, deal_id=stable_id("deal", legacy), deal_number=f"LW-{legacy}",
                side=base["side"], status=base["status"], address=base["address"], unit=base["unit"], city=base["city"],
                mls=base["mls"], sale_price=base["sale_price"], offer_date=base["offer_date"], close_date=base["close_date"],
                deposit_amount=base["deposit_amount"], deposit_holder=base["deposit_holder"], base_gci=base["base_gci"],
                hst=base["hst"], coop=base["coop"], agents=deal_agents, sellers=sellers, buyers=buyers, rows=rows,
            )
        except RowError as exc:
            for row_number, raw in rows:
                ledger.reject("deals", row_number, legacy, str(exc), raw)
    return deals


REVERSAL_WORDS = ("reversal", "reverse", "void", "nsf", "returned item", "bounced")
REFUND_WORDS = ("refund", "return to buyer", "returned to buyer", "release to buyer", "return of deposit")
DEPOSIT_WORDS = ("deposit", "receipt", "received")
OUTFLOW_WORDS = ("disburse", "release", "paid", "payment", "payout", "transfer", "withdraw", "commission", "cheque to", "wire to")
DISBURSEMENT_TYPES = [
    (("co-op", "coop", "cooperating", "co op"), "DISBURSEMENT_TO_COOP"),
    (("lawyer", "solicitor", "law office", "law firm", "llp", "professional corporation"), "DISBURSEMENT_TO_LAWYER"),
    (("commission", "general", "transfer to brokerage", "earned", "brokerage"), "DISBURSEMENT_TO_GENERAL"),
]


def classify_entry(type_text: str | None, counterparty: str | None, flow: str | None) -> str | None:
    t = (type_text or "").lower()
    if any(re.search(rf"\b{re.escape(w)}\b", t) for w in REVERSAL_WORDS):
        return "REVERSAL"
    if any(w in t for w in REFUND_WORDS):
        return "REFUND_TO_PAYER"
    outflow = flow == "out" or (flow is None and any(w in t for w in OUTFLOW_WORDS))
    if not outflow and (flow == "in" or any(w in t for w in DEPOSIT_WORDS)):
        return "DEPOSIT_RECEIVED"
    target = _classify(t, DISBURSEMENT_TYPES) or _classify(counterparty, DISBURSEMENT_TYPES)
    if target is None and flow == "out" and any(w in t for w in DEPOSIT_WORDS):
        return "REVERSAL"
    return target
METHODS = [
    (("certified",), "CERTIFIED_CHEQUE"),
    (("draft",), "BANK_DRAFT"),
    (("wire",), "WIRE"),
    (("eft", "e-transfer", "etransfer", "direct deposit", "electronic"), "EFT"),
    (("cheque", "check", "chq"), "CHEQUE"),
]
DEPOSIT_METHODS = {"BANK_DRAFT", "WIRE", "CERTIFIED_CHEQUE"}


def _classify(text_value: str | None, table: list[tuple[tuple[str, ...], str]]) -> str | None:
    s = (text_value or "").lower()
    for words, result in table:
        if any(w in s for w in words):
            return result
    return None


@dataclass
class TrustEntry:
    legacy_id: str
    entry_id: str
    deal_legacy_id: str
    entry_type: str
    amount: Decimal
    effective_date: date
    received_date: date | None
    method: str
    counterparty: str
    reference: str | None
    receipt_number: int | None
    account: str | None
    reverses: str | None
    memo: str | None
    direction: int
    row_number: int
    row: dict[str, Any]


def transform_trust(df: pd.DataFrame, cols: dict[str, str | None], deals: dict[str, Deal], rejected_deals: set[str], ledger: Ledger, opts: argparse.Namespace) -> dict[str, list[TrustEntry]]:
    entries: dict[str, TrustEntry] = {}
    for idx, raw in enumerate(df.to_dict("records")):
        row_number = idx + 2
        key = clean_text(get(raw, cols, "legacy_entry_id")) or f"row {row_number}"
        try:
            legacy = clean_text(get(raw, cols, "legacy_entry_id"))
            if not legacy:
                raise RowError("trust entry ID is blank")
            if legacy in entries:
                raise RowError(f"duplicate trust entry ID (first seen on row {entries[legacy].row_number})")
            deal_legacy = clean_text(get(raw, cols, "deal_id"))
            if not deal_legacy:
                raise RowError("trust entry has no deal ID; funds can't be held without a deal")
            if deal_legacy not in deals:
                raise RowError(f"deal {deal_legacy} " + ("was rejected (see its deal rows)" if deal_legacy in rejected_deals else "isn't in the deals export"))

            type_text = clean_text(get(raw, cols, "entry_type"))
            counterparty = clean_text(get(raw, cols, "counterparty"))
            if cols.get("amount"):
                signed = parse_money(get(raw, cols, "amount"), "amount", allow_negative=True)
                flow = "out" if signed is not None and signed < 0 else None
            else:
                credit = parse_money(get(raw, cols, "credit"), "credit") or Decimal("0")
                debit = parse_money(get(raw, cols, "debit"), "debit") or Decimal("0")
                if credit and debit:
                    raise RowError("entry has both a credit and a debit")
                signed = credit if credit else -debit
                flow = "in" if credit else "out"
            if signed is None or signed == 0:
                raise RowError("amount is missing or zero")

            entry_type = classify_entry(type_text, counterparty, flow)
            if entry_type is None:
                raise RowError(f"can't tell what kind of trust entry '{type_text or ''}' is (a deposit, or a disbursement to whom?)")

            reverses = clean_text(get(raw, cols, "reverses"))
            if entry_type == "REVERSAL" and not reverses:
                raise RowError("this reverses an earlier entry, but the export doesn't say which one")

            effective, note = parse_date(get(raw, cols, "date"), "date", opts.slash_dates, opts.dash_dates)
            if note:
                ledger.warn("trust", row_number, key, note, raw)
            if effective is None:
                raise RowError("entry date is missing")
            received, note = parse_date(get(raw, cols, "received_date"), "date received", opts.slash_dates, opts.dash_dates)
            if note:
                ledger.warn("trust", row_number, key, note, raw)

            method = _classify(clean_text(get(raw, cols, "method")), METHODS)
            reference = clean_text(get(raw, cols, "reference"))
            receipt_raw = clean_text(get(raw, cols, "receipt_number"))
            receipt = None
            if receipt_raw:
                digits = re.sub(r"\D", "", receipt_raw)
                receipt = int(digits) if digits and len(digits) <= 9 else None
                if receipt is None:
                    ledger.warn("trust", row_number, key, f"receipt number '{receipt_raw}' isn't numeric; a new one will be assigned", raw)

            if entry_type == "DEPOSIT_RECEIVED":
                if method is None:
                    raise RowError("deposit method is missing or unrecognised")
                if method not in DEPOSIT_METHODS:
                    raise RowError(f"deposit by {method} can't be receipted into the new trust ledger (bank draft, wire or certified cheque only); confirm how it was paid")
                if received is None:
                    received = effective
                    ledger.warn("trust", row_number, key, "date received missing; deposit date used", raw)
                if received > effective:
                    raise RowError(f"received {received} after it was deposited {effective}")
                late = business_days_between(received, effective)
                if late > TRUST_DEADLINE_BUSINESS_DAYS:
                    ledger.warn("trust", row_number, key, f"deposited {late} business days after receipt (limit {TRUST_DEADLINE_BUSINESS_DAYS}); imported as recorded", raw)
                if not reference:
                    reference = f"Lone Wolf {legacy}"
                    ledger.warn("trust", row_number, key, "no bank reference; Lone Wolf entry ID used", raw)
                if not counterparty:
                    raise RowError("deposit has no payor name")
            elif entry_type != "REVERSAL":
                if method is None:
                    raise RowError("disbursement method is missing or unrecognised")
                if method == "CERTIFIED_CHEQUE":
                    method = "CHEQUE"
                if not counterparty:
                    raise RowError("disbursement has no payee name")
            else:
                method = method or "EFT"

            entries[legacy] = TrustEntry(
                legacy_id=legacy, entry_id=stable_id("trust", legacy), deal_legacy_id=deal_legacy, entry_type=entry_type,
                amount=abs(signed), effective_date=effective, received_date=received if entry_type == "DEPOSIT_RECEIVED" else None,
                method=method, counterparty=counterparty or "Reversal", reference=reference, receipt_number=receipt,
                account=clean_text(get(raw, cols, "account")), reverses=reverses, memo=clean_text(get(raw, cols, "memo")),
                direction=1 if entry_type == "DEPOSIT_RECEIVED" else -1, row_number=row_number, row=raw,
            )
        except RowError as exc:
            ledger.reject("trust", row_number, key, str(exc), raw)

    by_deal: dict[str, list[TrustEntry]] = {}
    for e in entries.values():
        by_deal.setdefault(e.deal_legacy_id, []).append(e)

    deal_column = cols["deal_id"]
    failed_rows: dict[str, list[int]] = {}
    for row_number, raw, _ in ledger.rejected.get("trust", []):
        failed_rows.setdefault(clean_text(raw.get(deal_column)) or "", []).append(row_number)

    accepted: dict[str, list[TrustEntry]] = {}
    for deal_legacy, items in by_deal.items():
        items.sort(key=lambda e: (e.effective_date, e.row_number))
        try:
            if deal_legacy in failed_rows:
                rows = ", ".join(str(n) for n in sorted(failed_rows[deal_legacy]))
                raise RowError(f"another entry on this deal was rejected (row {rows}); a deal's trust history is imported all-or-nothing so its balance stays true")
            seen: dict[str, TrustEntry] = {}
            reversed_ids: set[str] = set()
            balance = Decimal("0.00")
            for e in items:
                if e.entry_type == "REVERSAL":
                    original = seen.get(e.reverses or "")
                    if original is None:
                        raise RowError(f"entry {e.legacy_id} reverses {e.reverses}, which isn't an earlier entry on this deal")
                    if original.entry_type == "REVERSAL" or original.legacy_id in reversed_ids:
                        raise RowError(f"entry {e.reverses} can't be reversed (already reversed, or is itself a reversal)")
                    if original.amount != e.amount:
                        raise RowError(f"reversal {e.legacy_id} is {e.amount} but the entry it reverses is {original.amount}")
                    e.direction = -original.direction
                    reversed_ids.add(original.legacy_id)
                balance += e.amount * e.direction
                if balance < 0:
                    raise RowError(f"the deal's trust ledger would go negative ({balance}) on {e.effective_date} at entry {e.legacy_id}; unbalanced, nothing imported for this deal")
                seen[e.legacy_id] = e
            deal = deals[deal_legacy]
            if deal.status in {"CLOSED", "COLLAPSED", "CANCELLED"} and balance != 0:
                ledger.warn("trust", items[-1].row_number, deal_legacy, f"{deal.status.lower()} deal still holds {balance} in trust after its last entry; imported as recorded, follow up", items[-1].row)
            accepted[deal_legacy] = items
        except RowError as exc:
            for e in items:
                ledger.reject("trust", e.row_number, e.legacy_id, str(exc), e.row)
    return accepted


def deposit_facts(deal: Deal, trust: list[TrustEntry]) -> tuple[str, Decimal, str]:
    deposited = sum((e.amount for e in trust if e.entry_type == "DEPOSIT_RECEIVED"), Decimal("0"))
    deposits_reversed = sum((e.amount for e in trust if e.entry_type == "REVERSAL" and e.direction < 0), Decimal("0"))
    received = deposited - deposits_reversed
    balance = sum((e.amount * e.direction for e in trust), Decimal("0"))
    holder = deal.deposit_holder or ("OUR_BROKERAGE" if trust else "COOP_BROKERAGE")
    amount = deal.deposit_amount if deal.deposit_amount is not None else max(received, Decimal("0.00"))
    if holder != "OUR_BROKERAGE":
        status = "HELD_ELSEWHERE"
    elif received <= 0:
        status = "AWAITING" if deal.status in {"CONDITIONAL", "FIRM"} else "NOT_DUE"
    elif balance == 0:
        refunds = any(e.entry_type == "REFUND_TO_PAYER" for e in trust)
        status = "REFUNDED" if refunds else "RELEASED"
    else:
        status = "RECEIVED"
    return holder, amount, status


def validate_structure(frames: dict[str, pd.DataFrame], cols: dict[str, dict[str, str | None]]) -> list[str]:
    findings: list[str] = []
    for source, df in frames.items():
        findings.append(f"{source}: {len(df)} rows, {len(df.columns)} columns")
        for fld, col in cols[source].items():
            if col:
                findings.append(f"  {fld:<22} <- '{col}'")
    agent_ids = frames["agents"][cols["agents"]["legacy_agent_id"]].map(clean_text)
    dupes = agent_ids[agent_ids.duplicated() & agent_ids.notna()].unique()
    if len(dupes):
        findings.append(f"agents: duplicate agent IDs: {', '.join(map(str, dupes[:20]))}")
    deal_agent_ids = set(frames["deals"][cols["deals"]["agent_id"]].map(clean_text).dropna())
    orphans = sorted(deal_agent_ids - set(agent_ids.dropna()))
    if orphans:
        findings.append(f"deals: {len(orphans)} agent ID(s) not in the agents export: {', '.join(orphans[:20])}")
    deal_ids = set(frames["deals"][cols["deals"]["legacy_deal_id"]].map(clean_text).dropna())
    trust_deals = set(frames["trust"][cols["trust"]["deal_id"]].map(clean_text).dropna())
    missing = sorted(trust_deals - deal_ids)
    if missing:
        findings.append(f"trust: {len(missing)} deal ID(s) not in the deals export: {', '.join(missing[:20])}")
    entry_ids = frames["trust"][cols["trust"]["legacy_entry_id"]].map(clean_text)
    dupes = entry_ids[entry_ids.duplicated() & entry_ids.notna()].unique()
    if len(dupes):
        findings.append(f"trust: duplicate entry IDs: {', '.join(map(str, dupes[:20]))}")
    return findings


def sqlalchemy_url(url: str) -> str:
    parts = urlsplit(url)
    scheme = "postgresql+psycopg2" if parts.scheme in {"postgres", "postgresql"} else parts.scheme
    query = [(k, v) for k, v in parse_qsl(parts.query) if k not in {"schema", "connection_limit", "pool_timeout", "pgbouncer", "socket_timeout"}]
    return urlunsplit((scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


def db_reason(exc: Exception) -> str:
    orig = getattr(exc, "orig", None)
    code = getattr(orig, "pgcode", None)
    message = str(orig if orig is not None else exc).strip().splitlines()[0]
    return f"database rejected it{f' [{code}]' if code else ''}: {message}"


def preflight(engine: Engine, broker_email: str, trust_account: str | None) -> tuple[str, dict[str, str]]:
    with engine.connect() as conn:
        for table in ("User", "Transaction", "TransactionAgent", "TrustLedgerEntry", "TrustAccount", "DocumentSlot"):
            if conn.execute(text("SELECT to_regclass(:t)"), {"t": f'"{table}"'}).scalar() is None:
                raise StructuralError(f'database is missing table "{table}"; run the schema migrations first')
        if conn.execute(text("SELECT to_regclass('\"ClosingStatement\"')")).scalar() is None:
            raise StructuralError("database is missing migration 005 (closing tables)")
        broker = conn.execute(text('SELECT id, role::text AS role, "isActive" FROM "User" WHERE lower(email) = lower(:e)'), {"e": broker_email}).mappings().first()
        if broker is None or broker["role"] != "MANAGING_BROKER" or not broker["isActive"]:
            raise StructuralError(f"{broker_email} must be an active MANAGING_BROKER: the trust ledger records who authorized every entry")
        accounts = conn.execute(text('SELECT id::text AS id, "accountLast4" AS last4 FROM "TrustAccount" WHERE "isActive"')).mappings().all()
    if not accounts:
        raise StructuralError("no active trust account in the database; create it before migrating trust entries")
    by_key = {a["last4"]: a["id"] for a in accounts} | {a["id"]: a["id"] for a in accounts}
    if trust_account:
        if trust_account not in by_key:
            raise StructuralError(f"trust account '{trust_account}' not found (use its last 4 digits or ID)")
        by_key["__default__"] = by_key[trust_account]
    elif len(accounts) == 1:
        by_key["__default__"] = accounts[0]["id"]
    return str(broker["id"]), by_key


def insert_agents(engine: Engine, agents: dict[str, Agent], ledger: Ledger, stats: dict[str, int]) -> dict[str, str]:
    ids: dict[str, str] = {}
    for a in agents.values():
        try:
            with engine.begin() as conn:
                existing = conn.execute(text('SELECT id::text FROM "User" WHERE lower(email) = :e'), {"e": a.email}).scalar()
                if existing:
                    ids[a.legacy_id] = existing
                    stats["agents_existing"] += 1
                    continue
                conn.execute(text("""
                    INSERT INTO "User" (id, email, "firstName", "lastName", phone, role, "recoRegistrationNo", "isPrec",
                                        "precLegalName", "hstNumber", "isActive", "updatedAt")
                    VALUES (CAST(:id AS uuid), :email, :first, :last, :phone, 'AGENT', :reco, :is_prec, :prec, :hst, :active, now())
                """), {"id": a.user_id, "email": a.email, "first": a.first_name, "last": a.last_name, "phone": a.phone, "reco": a.reco,
                       "is_prec": a.is_prec, "prec": a.prec_legal_name, "hst": a.hst_number, "active": a.active})
                ids[a.legacy_id] = a.user_id
                stats["agents_inserted"] += 1
        except (DBAPIError, SQLAlchemyError) as exc:
            ledger.reject("agents", a.row_number, a.legacy_id, db_reason(exc), a.row)
    return ids


SLOT_SQL = text("""
    INSERT INTO "DocumentSlot" (id, "documentTypeId", "transactionId", "updatedAt")
    SELECT gen_random_uuid(), dt.id, CAST(:deal AS uuid), now() FROM "DocumentType" dt
     WHERE dt."isActive" AND dt."slotScope" = 'DEAL' AND CAST(:side AS "DealSide") = ANY(dt."requiredFor")
    ON CONFLICT ("transactionId", "documentTypeId") WHERE "partyId" IS NULL AND "transactionId" IS NOT NULL DO NOTHING
""")
PARTY_SLOT_SQL = text("""
    INSERT INTO "DocumentSlot" (id, "documentTypeId", "transactionId", "partyId", "updatedAt")
    SELECT gen_random_uuid(), dt.id, p."transactionId", p.id, now()
      FROM "TransactionParty" p JOIN "DocumentType" dt
        ON dt."isActive" AND CAST(:side AS "DealSide") = ANY(dt."requiredFor")
       AND ((dt."slotScope" = 'CLIENT_INDIVIDUAL' AND p."entityType" = 'INDIVIDUAL') OR (dt."slotScope" = 'CLIENT_CORPORATION' AND p."entityType" = 'CORPORATION'))
     WHERE p."transactionId" = CAST(:deal AS uuid) AND p.role::text = ANY(:client_roles)
    ON CONFLICT ("transactionId", "documentTypeId", "partyId") WHERE "partyId" IS NOT NULL DO NOTHING
""")
CLIENT_ROLES = {"LISTING": ["SELLER"], "BUYER": ["BUYER"], "DUAL": ["SELLER", "BUYER"], "LANDLORD": ["LANDLORD"], "TENANT": ["TENANT"]}


def insert_deals(engine: Engine, deals: dict[str, Deal], user_ids: dict[str, str], trust: dict[str, list[TrustEntry]], ledger: Ledger, stats: dict[str, int]) -> dict[str, str]:
    ids: dict[str, str] = {}
    for d in deals.values():
        try:
            missing = [a.user_legacy_id for a in d.agents if a.user_legacy_id not in user_ids]
            if missing:
                raise RowError(f"agent(s) {', '.join(missing)} failed to import")
            holder, deposit_amount, deposit_status = deposit_facts(d, trust.get(d.legacy_id, []))
            with engine.begin() as conn:
                existing = conn.execute(text('SELECT id::text FROM "Transaction" WHERE "dealNumber" = :n'), {"n": d.deal_number}).scalar()
                if existing:
                    ids[d.legacy_id] = existing
                    stats["deals_existing"] += 1
                    continue
                corporate = re.compile(r"\b(inc|ltd|limited|corp|corporation|incorporated)\b\.?", re.I)
                conn.execute(text("""
                    INSERT INTO "Transaction" (id, "dealNumber", side, status, "streetAddress", unit, city, "mlsNumber", "salePrice",
                        "offerDate", "closeDate", "depositAmount", "trustDepositHolder", "depositStatus", "totalGci", "hstOnGci",
                        "coopCommission", "updatedAt")
                    VALUES (CAST(:id AS uuid), :number, CAST(:side AS "DealSide"), CAST(:status AS "DealStatus"), :address, :unit, :city,
                        :mls, :price, :offer, :close, :deposit, CAST(:holder AS "DepositHolder"), CAST(:dstatus AS "DepositStatus"),
                        :gci, :hst, :coop, now())
                """), {"id": d.deal_id, "number": d.deal_number, "side": d.side, "status": d.status, "address": d.address, "unit": d.unit,
                       "city": d.city, "mls": d.mls, "price": d.sale_price, "offer": d.offer_date, "close": d.close_date,
                       "deposit": deposit_amount, "holder": holder, "dstatus": deposit_status, "gci": d.base_gci, "hst": d.hst, "coop": d.coop})
                for a in d.agents:
                    conn.execute(text("""
                        INSERT INTO "TransactionAgent" (id, "transactionId", "userId", role, "splitPct", "gciSharePct", "grossShare", "netPayout")
                        VALUES (gen_random_uuid(), CAST(:deal AS uuid), CAST(:user AS uuid), CAST(:role AS "DealAgentRole"), :split, :share, :gross, :net)
                    """), {"deal": d.deal_id, "user": user_ids[a.user_legacy_id], "role": a.role, "split": a.split, "share": a.share,
                           "gross": a.gross, "net": a.net})
                for role, names in (("SELLER", d.sellers), ("BUYER", d.buyers)):
                    for name in names:
                        conn.execute(text("""
                            INSERT INTO "TransactionParty" (id, "transactionId", role, "entityType", "fullName")
                            VALUES (gen_random_uuid(), CAST(:deal AS uuid), CAST(:role AS "PartyRole"), CAST(:entity AS "PartyEntityType"), :name)
                        """), {"deal": d.deal_id, "role": role, "entity": "CORPORATION" if corporate.search(name) else "INDIVIDUAL", "name": name})
                if d.status in {"CONDITIONAL", "FIRM"}:
                    conn.execute(SLOT_SQL, {"deal": d.deal_id, "side": d.side})
                    conn.execute(PARTY_SLOT_SQL, {"deal": d.deal_id, "side": d.side, "client_roles": CLIENT_ROLES[d.side]})
                ids[d.legacy_id] = d.deal_id
                stats["deals_inserted"] += 1
        except RowError as exc:
            for row_number, raw in d.rows:
                ledger.reject("deals", row_number, d.legacy_id, str(exc), raw)
        except (DBAPIError, SQLAlchemyError) as exc:
            for row_number, raw in d.rows:
                ledger.reject("deals", row_number, d.legacy_id, db_reason(exc), raw)
    return ids


def insert_trust(engine: Engine, trust: dict[str, list[TrustEntry]], deal_ids: dict[str, str], deals: dict[str, Deal], broker_id: str,
                 accounts: dict[str, str], ledger: Ledger, stats: dict[str, int]) -> None:
    for deal_legacy, items in trust.items():
        try:
            if deal_legacy not in deal_ids:
                raise RowError(f"deal {deal_legacy} failed to import, so its trust entries can't be recorded")
            account_keys = {e.account for e in items}
            if len(account_keys) > 1:
                raise RowError(f"entries for this deal span trust accounts {sorted(map(str, account_keys))}; split per account first")
            key = items[0].account
            account_id = accounts.get((key or "")[-4:]) or accounts.get(key or "") or accounts.get("__default__")
            if not account_id:
                raise RowError("can't tell which trust account these entries belong to; pass --trust-account")
            deal_status = deals[deal_legacy].status
            with engine.begin() as conn:
                done = set(conn.execute(text('SELECT "idempotencyKey"::text FROM "TrustLedgerEntry" WHERE "transactionId" = CAST(:d AS uuid)'),
                                        {"d": deal_ids[deal_legacy]}).scalars())
                conn.execute(text('SELECT 1 FROM "TrustAccount" WHERE id = CAST(:a AS uuid) FOR UPDATE'), {"a": account_id})
                for e in items:
                    if e.entry_id in done:
                        stats["trust_existing"] += 1
                        continue
                    receipt = None
                    if e.entry_type == "DEPOSIT_RECEIVED":
                        taken = e.receipt_number is not None and conn.execute(
                            text('SELECT 1 FROM "TrustLedgerEntry" WHERE "receiptNumber" = :r'), {"r": e.receipt_number}).first() is not None
                        if e.receipt_number is not None and not taken:
                            receipt = e.receipt_number
                        else:
                            receipt = conn.execute(text('SELECT (COALESCE(MAX("receiptNumber"), 999) + 1)::int FROM "TrustLedgerEntry"')).scalar()
                            ledger.warn("trust", e.row_number, e.legacy_id,
                                        f"receipt number {'%s already in use' % e.receipt_number if taken else 'missing'}; assigned #{receipt}", e.row)
                    authorization, auth_ref = None, None
                    if e.entry_type in {"DISBURSEMENT_TO_GENERAL", "DISBURSEMENT_TO_COOP", "DISBURSEMENT_TO_LAWYER"}:
                        authorization = "CLOSING_COMPLETED" if deal_status == "CLOSED" else "MUTUAL_RELEASE"
                        auth_ref = f"Migrated from Lone Wolf entry {e.legacy_id}"
                    elif e.entry_type == "REFUND_TO_PAYER":
                        authorization, auth_ref = "MUTUAL_RELEASE", f"Migrated from Lone Wolf entry {e.legacy_id}"
                    memo = f"Migrated from Lone Wolf entry {e.legacy_id}" + (f" · {e.memo}" if e.memo else "")
                    conn.execute(text("""
                        INSERT INTO "TrustLedgerEntry" (id, "trustAccountId", "transactionId", "entryType", amount, method, "referenceNo",
                            "receiptNumber", counterparty, "receivedDate", "effectiveDate", "authorizationMethod", "authorizationReference",
                            memo, "reversesEntryId", "idempotencyKey", "enteredById", "authorizedById")
                        VALUES (CAST(:id AS uuid), CAST(:account AS uuid), CAST(:deal AS uuid), CAST(:type AS "TrustEntryType"), :amount,
                            CAST(:method AS "PaymentMethod"), :reference, :receipt, :counterparty, :received, :effective,
                            CAST(:auth AS "TrustAuthorization"), :auth_ref, :memo, CAST(:reverses AS uuid), CAST(:key AS uuid),
                            CAST(:broker AS uuid), CAST(:broker AS uuid))
                    """), {"id": e.entry_id, "account": account_id, "deal": deal_ids[deal_legacy], "type": e.entry_type, "amount": e.amount,
                           "method": e.method, "reference": e.reference, "receipt": receipt, "counterparty": e.counterparty,
                           "received": e.received_date, "effective": e.effective_date, "auth": authorization, "auth_ref": auth_ref,
                           "memo": memo, "reverses": stable_id("trust", e.reverses) if e.reverses else None, "key": e.entry_id, "broker": broker_id})
                    stats["trust_inserted"] += 1
        except RowError as exc:
            for e in items:
                ledger.reject("trust", e.row_number, e.legacy_id, str(exc), e.row)
        except (DBAPIError, SQLAlchemyError) as exc:
            for e in items:
                ledger.reject("trust", e.row_number, e.legacy_id, db_reason(exc), e.row)


def write_rejects(out_dir: Path, frames: dict[str, pd.DataFrame], ledger: Ledger) -> dict[str, str]:
    paths = {}
    for source, items in ledger.rejected.items():
        if not items:
            continue
        reasons: dict[int, list[str]] = {}
        for row_number, _, reason in items:
            reasons.setdefault(row_number, [])
            if reason not in reasons[row_number]:
                reasons[row_number].append(reason)
        df = frames[source].copy()
        df.insert(0, "_row_number", range(2, len(df) + 2))
        df = df[df["_row_number"].isin(reasons)]
        df["_error"] = df["_row_number"].map(lambda n: " | ".join(reasons[n]))
        path = out_dir / f"rejected_{source}.csv"
        df.to_csv(path, index=False)
        paths[source] = str(path)
    return paths


def configure_logging(path: Path) -> None:
    log.setLevel(logging.INFO)
    log.handlers.clear()
    handler = logging.FileHandler(path, mode="a", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(handler)
    log.propagate = False


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Migrate Lone Wolf exports (agents, deals, trust ledger) into the Ontario brokerage database.")
    p.add_argument("--agents", type=Path, default=Path("agents_export.csv"))
    p.add_argument("--deals", type=Path, default=Path("deals_historical_export.csv"))
    p.add_argument("--trust", type=Path, default=Path("trust_ledger_export.csv"))
    p.add_argument("--database-url", default=os.environ.get("DATABASE_URL"), help="PostgreSQL URL (default: $DATABASE_URL)")
    p.add_argument("--broker-email", help="Active MANAGING_BROKER recorded as authorizing the migrated trust entries")
    p.add_argument("--trust-account", help="Trust account (last 4 digits or ID) for entries without an account column")
    p.add_argument("--slash-dates", choices=["DMY", "MDY"], default="DMY", help="How to read 03/04/2024 (default DMY: 3 April)")
    p.add_argument("--dash-dates", choices=["DMY", "MDY"], default="MDY", help="How to read 03-04-24 (default MDY: March 4)")
    p.add_argument("--column-map", type=Path, help='JSON: {"agents": {"email": "Agent E-mail"}, "deals": {...}, "trust": {...}}')
    p.add_argument("--error-log", type=Path, default=Path("ontario_migration_errors.log"))
    p.add_argument("--out-dir", type=Path, default=Path("migration_out"))
    p.add_argument("--max-reject-rate", type=float, default=0.10, help="Stop before writing if more than this share of rows fails validation")
    p.add_argument("--force", action="store_true", help="Write even if the reject rate is above the limit")
    p.add_argument("--dry-run", action="store_true", help="Validate and report only; no database writes")
    return p.parse_args(argv)


def run(opts: argparse.Namespace) -> int:
    opts.out_dir.mkdir(parents=True, exist_ok=True)
    configure_logging(opts.error_log)
    log.info(json.dumps({"event": "start", "dry_run": opts.dry_run, "files": [str(opts.agents), str(opts.deals), str(opts.trust)]}))
    ledger = Ledger()
    stats = {k: 0 for k in ("agents_inserted", "agents_existing", "deals_inserted", "deals_existing", "trust_inserted", "trust_existing")}

    try:
        overrides = json.loads(opts.column_map.read_text()) if opts.column_map else {}
        frames = {"agents": read_csv(opts.agents, "agents"), "deals": read_csv(opts.deals, "deals"), "trust": read_csv(opts.trust, "trust")}
        cols = {
            "agents": resolve_columns(frames["agents"], AGENT_COLUMNS, "agents", overrides.get("agents", {})),
            "deals": resolve_columns(frames["deals"], DEAL_COLUMNS, "deals", overrides.get("deals", {})),
            "trust": resolve_columns(frames["trust"], TRUST_COLUMNS, "trust", overrides.get("trust", {})),
        }
        if not opts.dry_run:
            if not opts.database_url:
                raise StructuralError("no database URL: pass --database-url or set DATABASE_URL")
            if not opts.broker_email:
                raise StructuralError("--broker-email is required to write trust entries")
    except (StructuralError, json.JSONDecodeError, OSError) as exc:
        log.critical(json.dumps({"event": "structural_failure", "reason": str(exc)}))
        print(f"STOPPED before any database work: {exc}", file=sys.stderr)
        return 2

    findings = validate_structure(frames, cols)
    print("\n".join(["Structural checks:"] + findings))

    agents = transform_agents(frames["agents"], cols["agents"], ledger)
    deals = transform_deals(frames["deals"], cols["deals"], agents, ledger, opts)
    deal_ids_in_file = set(frames["deals"][cols["deals"]["legacy_deal_id"]].map(clean_text).dropna())
    trust = transform_trust(frames["trust"], cols["trust"], deals, deal_ids_in_file - set(deals), ledger, opts)

    total_rows = sum(len(df) for df in frames.values())
    rejected_rows = sum(len({n for n, _, _ in items}) for items in ledger.rejected.values())
    reject_rate = rejected_rows / total_rows if total_rows else 0.0
    trust_rows = sum(len(v) for v in trust.values())
    print(f"Validation: {len(agents)} agents, {len(deals)} deals, {trust_rows} trust entries ready; "
          f"{rejected_rows} of {total_rows} rows rejected ({reject_rate:.1%})")

    exit_code = 0
    if opts.dry_run:
        print("Dry run: nothing written.")
    elif reject_rate > opts.max_reject_rate and not opts.force:
        print(f"STOPPED: {reject_rate:.1%} of rows failed validation (limit {opts.max_reject_rate:.0%}). "
              f"Check the column mapping and {opts.error_log}, or rerun with --force.", file=sys.stderr)
        exit_code = 3
    else:
        try:
            engine = create_engine(sqlalchemy_url(opts.database_url), pool_pre_ping=True, future=True)
            broker_id, accounts = preflight(engine, opts.broker_email, opts.trust_account)
        except (StructuralError, SQLAlchemyError) as exc:
            log.critical(json.dumps({"event": "preflight_failure", "reason": str(exc)}))
            print(f"STOPPED before writing: {exc}", file=sys.stderr)
            return 2
        user_ids = insert_agents(engine, agents, ledger, stats)
        deal_ids = insert_deals(engine, deals, user_ids, trust, ledger, stats)
        insert_trust(engine, trust, deal_ids, deals, broker_id, accounts, ledger, stats)
        engine.dispose()

    rejects = write_rejects(opts.out_dir, frames, ledger)
    trust_totals: dict[str, str] = {}
    for items in trust.values():
        for e in items:
            trust_totals[e.entry_type] = str(Decimal(trust_totals.get(e.entry_type, "0")) + e.amount)
    report = {
        "dry_run": opts.dry_run,
        "rows_read": {k: len(v) for k, v in frames.items()},
        "rows_rejected": {k: len({n for n, _, _ in v}) for k, v in ledger.rejected.items()},
        "warnings": {s: ledger.count(s, "WARNING") for s in frames},
        "written": stats,
        "validated_trust_totals": trust_totals,
        "rejected_files": rejects,
        "error_log": str(opts.error_log),
    }
    (opts.out_dir / "migration_report.json").write_text(json.dumps(report, indent=2))
    log.info(json.dumps({"event": "finish", **report}))
    print(json.dumps(report, indent=2))
    if exit_code == 0 and any(report["rows_rejected"].values()):
        exit_code = 1
    return exit_code


def main(argv: list[str] | None = None) -> int:
    return run(parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
