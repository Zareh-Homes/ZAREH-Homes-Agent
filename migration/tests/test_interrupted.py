"""A migration cut off part way (lost connection, killed process) resumes cleanly on the next run."""
import json

import pytest

import lonewolf_migrate as m
from test_end_to_end import DATABASE_URL, args, engine, q, setup  # noqa: F401  (pytest fixtures)

pytestmark = pytest.mark.skipif(not DATABASE_URL, reason="DATABASE_URL not set")


def test_interrupted_run_resumes_and_ties_out(engine, setup, monkeypatch):
    real = m.insert_trust

    def cut_off(engine_, trust, deal_ids, deals, broker_id, accounts, ledger, stats):
        first = dict(list(trust.items())[:1])
        real(engine_, first, deal_ids, deals, broker_id, accounts, ledger, stats)
        raise ConnectionError("connection to the database was lost")

    monkeypatch.setattr(m, "insert_trust", cut_off)
    with pytest.raises(ConnectionError):
        m.main(args(setup, "--force"))
    partial = q(engine, """SELECT COUNT(*) AS n FROM "TrustLedgerEntry" e JOIN "Transaction" t ON t.id = e."transactionId"
                           WHERE t."dealNumber" LIKE :p""", p=f"LW-T%{setup['run']}")[0]["n"]
    assert 0 < partial < 8  # some trust history written, not all

    monkeypatch.setattr(m, "insert_trust", real)
    assert m.main(args(setup, "--force")) == 1  # 1 = finished, with the fixture's deliberately bad rows rejected
    report = json.loads((setup["work"] / "out" / "migration_report.json").read_text())
    assert report["written"]["trust_existing"] == partial
    assert report["written"]["trust_inserted"] == 8 - partial
    assert report["verification"]["matches"] is True
    total = q(engine, """SELECT COUNT(*) AS n FROM "TrustLedgerEntry" e JOIN "Transaction" t ON t.id = e."transactionId"
                         WHERE t."dealNumber" LIKE :p""", p=f"LW-T%{setup['run']}")[0]["n"]
    assert total == 8
