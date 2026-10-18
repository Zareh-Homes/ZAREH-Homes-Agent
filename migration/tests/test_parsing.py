from datetime import date
from decimal import Decimal

import pytest

import lonewolf_migrate as m


@pytest.mark.parametrize("raw, expected", [
    ("$1,100,000.00", "1100000.00"),
    ("  27,500 ", "27500.00"),
    ("CAD 3 575,00 $", "3575.00"),
    ("1.234,56", "1234.56"),
    ("(24,860.00)", "-24860.00"),
    ("30,140.00-", "-30140.00"),
    ("$-150", "-150.00"),
    ("1234.565", "1234.57"),
    (" 1,000", "1000.00"),
])
def test_money_sanitised_to_exact_cents(raw, expected):
    assert m.parse_money(raw, "amount", allow_negative=True) == Decimal(expected)


@pytest.mark.parametrize("raw", ["twelve", "$1,2a0", "1.2.3"])
def test_money_rejects_junk(raw):
    with pytest.raises(m.RowError):
        m.parse_money(raw, "amount")


def test_money_blank_and_negative_rules():
    assert m.parse_money("  ", "amount") is None
    assert m.parse_money("N/A", "amount") is None
    with pytest.raises(m.RowError, match="negative"):
        m.parse_money("-5", "amount")


def test_percentages_and_splits():
    assert m.parse_percent("80%", "split") == (Decimal("80.00"), None)
    assert m.parse_percent("80/20", "split") == (Decimal("80.00"), None)
    value, note = m.parse_percent("0.8", "split")
    assert value == Decimal("80.00") and "fraction" in note
    with pytest.raises(m.RowError):
        m.parse_percent("120", "split")


@pytest.mark.parametrize("raw, expected", [
    ("30/11/2024", date(2024, 11, 30)),
    ("05/03/2024", date(2024, 3, 5)),
    ("11-30-24", date(2024, 11, 30)),
    ("03-05-24", date(2024, 3, 5)),
    ("2024-11-30", date(2024, 11, 30)),
    ("2024/11/30", date(2024, 11, 30)),
    ("2024-11-30 00:00:00", date(2024, 11, 30)),
    ("30-Nov-2024", date(2024, 11, 30)),
    ("Nov 30, 2024", date(2024, 11, 30)),
])
def test_dates_normalised_to_iso(raw, expected):
    value, note = m.parse_date(raw, "date")
    assert value == expected and note is None


def test_date_that_only_works_the_other_way_is_read_that_way_with_a_warning():
    value, note = m.parse_date("11/30/2024", "close date")
    assert value == date(2024, 11, 30)
    assert "MM/DD" in note


def test_excel_serial_dates_are_flagged():
    value, note = m.parse_date("45626", "close date")
    assert value == date(2024, 11, 30) and "Excel" in note


@pytest.mark.parametrize("raw", ["31/02/2024", "13/13/2024", "yesterday", "01/01/1975"])
def test_impossible_dates_rejected(raw):
    with pytest.raises(m.RowError):
        m.parse_date(raw, "date")


def test_slash_order_can_be_switched():
    value, _ = m.parse_date("05/03/2024", "date", slash_order="MDY")
    assert value == date(2024, 5, 3)


def test_ontario_tax_rate_follows_the_transaction_date():
    assert m.tax_rate("ON", date(2024, 11, 30)) == (Decimal("0.13"), "HST")
    assert m.tax_rate("Ontario", date(2010, 7, 1)) == (Decimal("0.13"), "HST")
    assert m.tax_rate(None, date(2010, 6, 30)) == (Decimal("0.05"), "GST")
    assert m.tax_rate("ON", date(2007, 3, 1)) == (Decimal("0.06"), "GST")
    with pytest.raises(m.RowError, match="province"):
        m.tax_rate("BC", date(2024, 1, 1))


def test_tax_verified_derived_or_left_missing_never_invented():
    rate = Decimal("0.13")
    assert m.reconcile_tax(Decimal("27500.00"), Decimal("3575.00"), None, rate, "HST") == (
        Decimal("27500.00"), Decimal("3575.00"), "RECORDED", [])

    base, tax, source, notes = m.reconcile_tax(Decimal("27500.00"), None, None, rate, "HST")
    assert (tax, source) == (None, "MISSING")
    assert "left blank" in notes[0] and "would be 3575.00" in notes[0]

    base, tax, source, notes = m.reconcile_tax(None, None, Decimal("31075.00"), rate, "HST")
    assert (base, tax, source) == (Decimal("27500.00"), Decimal("3575.00"), "DERIVED_FROM_TOTAL") and "backed out" in notes[0]

    base, tax, source, notes = m.reconcile_tax(Decimal("10000.00"), Decimal("1000.00"), None, rate, "HST")
    assert (tax, source) == (Decimal("1000.00"), "RECORDED") and "expected 1300.00" in notes[0]

    with pytest.raises(m.RowError, match="doesn't equal"):
        m.reconcile_tax(Decimal("27500.00"), Decimal("3575.00"), Decimal("31000.00"), rate, "HST")


def test_trust_entry_classification_uses_direction_not_just_keywords():
    assert m.classify_entry("Deposit", "Bo Kim", None) == "DEPOSIT_RECEIVED"
    assert m.classify_entry("Release of deposit to lawyer", None, None) == "DISBURSEMENT_TO_LAWYER"
    assert m.classify_entry("Co-op commission", None, "out") == "DISBURSEMENT_TO_COOP"
    assert m.classify_entry("Disbursement", "Patel Law LLP", "out") == "DISBURSEMENT_TO_LAWYER"
    assert m.classify_entry("Deposit", None, "out") == "REVERSAL"
    assert m.classify_entry("NSF reversal", None, None) == "REVERSAL"
    assert m.classify_entry("Commission transfer", "Brokerage", "out") == "DISBURSEMENT_TO_GENERAL"
    assert m.classify_entry("Deposit refund", None, None) == "REFUND_TO_PAYER"
    assert m.classify_entry("Misc", None, "out") is None


def test_business_days_skip_weekends_and_ontario_holidays():
    assert m.business_days_between(date(2026, 10, 2), date(2026, 10, 9)) == 5
    assert m.business_days_between(date(2026, 10, 2), date(2026, 10, 12)) == 5  # Thanksgiving
    assert m.business_days_between(date(2026, 10, 2), date(2026, 10, 13)) == 6
    assert m.business_days_between(date(2026, 4, 1), date(2026, 4, 10)) == 5  # Good Friday, Easter Monday
    assert m.business_days_between(date(2026, 12, 23), date(2026, 12, 31)) == 5  # Christmas, Boxing Day on Saturday
    assert m.easter_sunday(2027) == date(2027, 3, 28)
    assert date(2022, 12, 27) in m.ontario_holidays(2022)  # Christmas on a Sunday: Tuesday too
    assert date(2026, 8, 3) not in m.ontario_holidays(2026)  # Civic Holiday off by default


def test_error_log_rows_are_redacted():
    row = m.redact_row({
        "Agent ID": "A1", "Email": "Jane.Smith@x.test", "Cell": "416-555-0101", "Seller": "Ann Lee",
        "Bank Account #": "004-12345-6789012", "Date of Birth": "1970-01-01", "Memo": "acct 12345678901", "Amount": "12345678.00",
        "Trade #": "T123456789",
    })
    assert row == {
        "Agent ID": "A1", "Email": "J***@x.test", "Cell": "***0101", "Seller": "A. L.",
        "Bank Account #": "***9012", "Date of Birth": "[redacted]", "Memo": "acct ****8901", "Amount": "12345678.00",
        "Trade #": "T123456789",
    }


def test_database_url_accepts_prisma_style():
    url = m.sqlalchemy_url("postgresql://u@localhost:5432/db?schema=public&host=/var/run")
    assert url == "postgresql+psycopg2://u@localhost:5432/db?host=%2Fvar%2Frun"
