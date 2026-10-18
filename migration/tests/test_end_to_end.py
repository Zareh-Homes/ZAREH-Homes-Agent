import json
import os
import random
import uuid
from decimal import Decimal
from pathlib import Path

import pandas as pd
import pytest
from sqlalchemy import create_engine, text

import lonewolf_migrate as m

DATABASE_URL = os.environ.get("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL not set")
FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture(scope="module")
def engine():
    eng = create_engine(m.sqlalchemy_url(DATABASE_URL))
    yield eng
    eng.dispose()


@pytest.fixture(scope="module")
def setup(engine, tmp_path_factory):
    run = uuid.uuid4().hex[:6]
    receipt = random.randint(500_000, 900_000)
    work = tmp_path_factory.mktemp("migration")
    for name in ("agents_export.csv", "deals_historical_export.csv", "trust_ledger_export.csv"):
        content = (FIXTURES / name).read_text(encoding="utf-8").replace("{run}", run).replace("{r1}", str(receipt))
        (work / name).write_text(content, encoding="utf-8")
    broker_email = f"broker.{run}@example.test"
    last4 = f"{random.randint(0, 9999):04d}"
    with engine.begin() as conn:
        broker = conn.execute(text("""INSERT INTO "User" (id, email, "firstName", "lastName", role, "updatedAt")
                             VALUES (gen_random_uuid(), :e, 'Broker', 'Migration', 'MANAGING_BROKER', now()) RETURNING id::text"""),
                              {"e": broker_email}).scalar()
        admin = conn.execute(text("""INSERT INTO "User" (id, email, "firstName", "lastName", role, "updatedAt")
                             VALUES (gen_random_uuid(), :e, 'Records', 'Admin', 'ADMIN', now()) RETURNING id::text"""),
                             {"e": f"admin.{run}@example.test"}).scalar()
        conn.execute(text("""INSERT INTO "BrokerOfRecordDesignation" (id, "userId", role, "effectiveFrom", reference, "createdById")
                             VALUES (gen_random_uuid(), CAST(:b AS uuid), 'DESIGNATED_SUBSTITUTE', '2000-01-01', 'Test', CAST(:a AS uuid))"""),
                     {"b": broker, "a": admin})
        account = conn.execute(text("""INSERT INTO "TrustAccount" (id, name, "bankName", "accountLast4")
                                       VALUES (gen_random_uuid(), 'Migration trust', 'TD', :l) RETURNING id::text"""), {"l": last4}).scalar()
    return {"run": run, "receipt": receipt, "work": work, "broker": broker_email, "account": account}


def args(setup, *extra):
    w = setup["work"]
    return [
        "--agents", str(w / "agents_export.csv"), "--deals", str(w / "deals_historical_export.csv"),
        "--trust", str(w / "trust_ledger_export.csv"), "--database-url", DATABASE_URL,
        "--broker-email", setup["broker"], "--trust-account", setup["account"],
        "--error-log", str(w / "ontario_migration_errors.log"), "--out-dir", str(w / "out"), *extra,
    ]


def q(engine, sql, **params):
    with engine.connect() as conn:
        return conn.execute(text(sql), params).mappings().all()


def test_1_stops_before_writing_when_too_many_rows_fail(engine, setup):
    assert m.main(args(setup)) == 3
    assert q(engine, 'SELECT 1 FROM "User" WHERE email = :e', e=f"jane.smith.{setup['run']}@example.test") == []


def test_2_dry_run_writes_nothing(engine, setup):
    assert m.main(args(setup, "--dry-run")) == 1
    assert q(engine, 'SELECT 1 FROM "Transaction" WHERE "dealNumber" = :n', n=f"LW-T1{setup['run']}") == []


@pytest.fixture(scope="module")
def migrated(engine, setup):
    code = m.main(args(setup, "--force"))
    report = json.loads((setup["work"] / "out" / "migration_report.json").read_text())
    return code, report


def test_3_report_counts(migrated):
    code, report = migrated
    assert code == 1
    assert report["rows_read"] == {"agents": 6, "deals": 12, "trust": 15}
    assert report["rows_rejected"] == {"agents": 2, "deals": 6, "trust": 7}
    assert report["written"] == {
        "agents_inserted": 4, "agents_existing": 0, "deals_inserted": 5, "deals_existing": 0,
        "trust_inserted": 8, "trust_existing": 0, "trust_attested_pre_cutover": 8,
    }


def test_4_agents_prec_and_hst_alignment(engine, setup, migrated):
    run = setup["run"]
    rows = {r["email"]: r for r in q(engine, """SELECT email, "firstName", "lastName", "isPrec", "precLegalName", "hstNumber", "isActive"
                                                FROM "User" WHERE email LIKE :p""", p=f"%.{run}@example.test")}
    jane = rows[f"jane.smith.{run}@example.test"]
    assert (jane["firstName"], jane["lastName"]) == ("Jane", "Smith")
    assert jane["isPrec"] is True
    assert jane["precLegalName"] == "Jane Smith Personal Real Estate Corporation"
    assert jane["hstNumber"] == "123456789RT0001"
    assert rows[f"omar.haddad.{run}@example.test"]["hstNumber"] is None
    priya = rows[f"priya.shah.{run}@example.test"]
    assert priya["isPrec"] is False and priya["precLegalName"] is None
    assert rows[f"ana.cote.{run}@example.test"]["isActive"] is False
    assert f"someone.else.{run}@example.test" not in rows


def test_5_deals_tax_dates_and_money(engine, setup, migrated):
    run = setup["run"]
    deals = {r["dealNumber"]: r for r in q(engine, """
        SELECT "dealNumber", side::text, status::text, "streetAddress", city, "mlsNumber", "salePrice", "offerDate"::text,
               "closeDate"::text, "totalGci", "hstOnGci", "hstSource"::text, "coopCommission", "trustDepositHolder"::text, "depositStatus"::text
          FROM "Transaction" WHERE "dealNumber" LIKE :p""", p=f"LW-T%{run}")}
    assert sorted(deals) == sorted(f"LW-T{n}{run}" for n in (1, 2, 3, 4, 5))

    t1 = deals[f"LW-T1{run}"]
    assert (t1["offerDate"], t1["closeDate"]) == ("2024-09-10", "2024-11-30")
    assert (t1["salePrice"], t1["totalGci"], t1["hstOnGci"], t1["coopCommission"]) == (
        Decimal("1100000.00"), Decimal("27500.00"), Decimal("3575.00"), Decimal("22000.00"))
    assert t1["hstSource"] == "RECORDED"
    assert t1["mlsNumber"] == "C1234567"
    assert t1["depositStatus"] == "RELEASED"

    t2 = deals[f"LW-T2{run}"]
    assert (t2["side"], t2["status"]) == ("BUYER", "CLOSED")
    assert (t2["totalGci"], t2["hstOnGci"], t2["hstSource"]) == (Decimal("27500.00"), Decimal("3575.00"), "DERIVED_FROM_TOTAL")
    assert t2["trustDepositHolder"] == "COOP_BROKERAGE"

    t3 = deals[f"LW-T3{run}"]
    assert (t3["streetAddress"], t3["city"]) == ("12 Main St E", "Grimsby")
    assert (t3["hstOnGci"], t3["hstSource"]) == (None, "MISSING")

    assert (deals[f"LW-T4{run}"]["hstOnGci"], deals[f"LW-T4{run}"]["hstSource"]) == (Decimal("1000.00"), "RECORDED")
    assert deals[f"LW-T5{run}"]["depositStatus"] == "RECEIVED"


def test_6_co_listing_agents_and_compliance_slots(engine, setup, migrated):
    run = setup["run"]
    agents = q(engine, """SELECT ta.role::text, ta."splitPct", ta."gciSharePct" FROM "TransactionAgent" ta
                          JOIN "Transaction" t ON t.id = ta."transactionId" WHERE t."dealNumber" = :n ORDER BY ta.role""", n=f"LW-T5{run}")
    assert [(a["role"], a["splitPct"], a["gciSharePct"]) for a in agents] == [
        ("PRIMARY", Decimal("80.00"), Decimal("50.00")), ("CO_AGENT", Decimal("75.00"), Decimal("50.00"))]
    slots = q(engine, """SELECT dt.code FROM "DocumentSlot" s JOIN "DocumentType" dt ON dt.id = s."documentTypeId"
                         JOIN "Transaction" t ON t.id = s."transactionId" WHERE t."dealNumber" = :n ORDER BY dt.code""", n=f"LW-T5{run}")
    assert [s["code"] for s in slots] == ["FINTRAC_INDIVIDUAL", "FORM_200"]
    closed_slots = q(engine, """SELECT 1 FROM "DocumentSlot" s JOIN "Transaction" t ON t.id = s."transactionId"
                                WHERE t."dealNumber" = :n""", n=f"LW-T1{run}")
    assert closed_slots == []


def test_7_trust_ledgers_balance_and_link_reversals(engine, setup, migrated):
    run = setup["run"]
    entries = q(engine, """SELECT t."dealNumber", e."entryType"::text AS type, e.amount, e.direction, e."receiptNumber",
                                  e."reversesEntryId"::text AS reverses, e.id::text AS id, e."authorizedById"::text AS by, e.memo
                             FROM "TrustLedgerEntry" e JOIN "Transaction" t ON t.id = e."transactionId"
                            WHERE t."dealNumber" LIKE :p ORDER BY t."dealNumber", e."createdAt" """, p=f"LW-T%{run}")
    by_deal = {}
    for e in entries:
        by_deal.setdefault(e["dealNumber"], []).append(e)
    assert sorted(by_deal) == [f"LW-T1{run}", f"LW-T4{run}", f"LW-T5{run}"]
    assert sum(e["amount"] * e["direction"] for e in by_deal[f"LW-T1{run}"]) == 0
    assert sum(e["amount"] * e["direction"] for e in by_deal[f"LW-T4{run}"]) == 0
    assert by_deal[f"LW-T1{run}"][0]["receiptNumber"] == setup["receipt"]
    t4 = by_deal[f"LW-T4{run}"]
    assert [e["type"] for e in t4] == ["DEPOSIT_RECEIVED", "REVERSAL", "DEPOSIT_RECEIVED", "DISBURSEMENT_TO_GENERAL"]
    assert t4[1]["reverses"] == t4[0]["id"]
    assert all(e["memo"].startswith("Migrated from Lone Wolf entry") for e in entries)
    broker = q(engine, 'SELECT id::text FROM "User" WHERE email = :e', e=setup["broker"])[0]["id"]
    assert all(e["by"] == broker for e in entries)
    attested = q(engine, """SELECT m.basis::text AS basis, m."matchedById"::text AS by FROM "BankMatch" m
                             JOIN "TrustLedgerEntry" e ON e.id = m."trustEntryId" JOIN "Transaction" t ON t.id = e."transactionId"
                            WHERE t."dealNumber" LIKE :p""", p=f"LW-T%{run}")
    assert len(attested) == len(entries) and all(a["basis"] == "PRE_CUTOVER" and a["by"] == broker for a in attested)


def test_8_error_log_and_rejected_files(setup, migrated):
    run = setup["run"]
    lines = [json.loads(line.split(" ", 3)[3]) for line in (setup["work"] / "ontario_migration_errors.log").read_text().splitlines()
             if " ERROR " in line or " WARNING " in line]
    errors = [e for e in lines if e.get("severity") == "ERROR"]
    by_reason = lambda needle: [e for e in errors if needle in e["reason"]]
    assert by_reason("email 'not-an-email'")[0]["row_number"] == 5
    assert by_reason("email 'not-an-email'")[0]["row"]["Agent ID"] == f"A103{run}"
    assert by_reason(f"agent ID A999{run}")
    assert by_reason("rows for this deal disagree on: sale_price")
    assert by_reason("co-op commission")
    assert by_reason("not a real date")
    assert by_reason("province 'BC'")
    assert by_reason("would go negative")
    assert by_reason("deposit by CHEQUE")
    assert by_reason("doesn't say which one") or by_reason("negative")
    assert by_reason("all-or-nothing")
    warnings = [e for e in lines if e.get("severity") == "WARNING"]
    assert any("expected 1300.00" in w["reason"] for w in warnings)
    assert any("backed out of combined commission" in w["reason"] for w in warnings)
    assert any("left blank and marked MISSING (5% GST would be 1000.00)" in w["reason"] for w in warnings)
    jane = next(w for w in warnings if w["row"].get("Agent ID") == f"A101{run}")
    assert jane["row"]["Email"].startswith("o***@") and jane["row"]["Cell"] == "***0102"
    assert any("9 business days after receipt" in w["reason"] for w in warnings)
    assert any("isn't named as a Personal Real Estate Corporation" in w["reason"] for w in warnings)

    rejected = pd.read_csv(setup["work"] / "out" / "rejected_trust.csv", dtype=str)
    assert len(rejected) == 7
    assert rejected["_error"].str.len().min() > 0
    assert set(rejected.columns[:2]) == {"_row_number", "Entry ID"}


def test_9_rerun_is_idempotent(engine, setup, migrated):
    assert m.main(args(setup, "--force")) == 1
    report = json.loads((setup["work"] / "out" / "migration_report.json").read_text())
    assert report["written"] == {
        "agents_inserted": 0, "agents_existing": 4, "deals_inserted": 0, "deals_existing": 5,
        "trust_inserted": 0, "trust_existing": 8, "trust_attested_pre_cutover": 0,
    }
    count = q(engine, """SELECT COUNT(*) AS n FROM "TrustLedgerEntry" e JOIN "Transaction" t ON t.id = e."transactionId"
                         WHERE t."dealNumber" LIKE :p""", p=f"LW-T%{setup['run']}")[0]["n"]
    assert count == 8


def test_structural_failure_stops_cleanly(tmp_path):
    bad = tmp_path / "agents.csv"
    bad.write_text("Something,Else\n1,2\n")
    code = m.main(["--agents", str(bad), "--deals", str(bad), "--trust", str(bad), "--dry-run",
                   "--error-log", str(tmp_path / "e.log"), "--out-dir", str(tmp_path / "out")])
    assert code == 2
    assert "required column(s) not found" in (tmp_path / "e.log").read_text()
