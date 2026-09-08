from app.finance import calculate_metrics


def test_metrics_use_cost_profitability():
    result = calculate_metrics([45_000_00], [14_000_00, 3_500_00, 2_000_00])
    assert result.income_cents == 45_000_00
    assert result.expense_cents == 19_500_00
    assert result.profit_cents == 25_500_00
    assert result.profitability_percent == 130.77


def test_negative_profitability():
    result = calculate_metrics([10_000], [15_000])
    assert result.profit_cents == -5_000
    assert result.profitability_percent == -33.33


def test_zero_expense_has_no_division_by_zero():
    result = calculate_metrics([10_000], [])
    assert result.profit_cents == 10_000
    assert result.profitability_percent is None


def test_integer_cents_are_exact():
    result = calculate_metrics([10, 20, 30], [1, 2, 3])
    assert result.income_cents == 60
    assert result.expense_cents == 6
    assert result.profit_cents == 54
