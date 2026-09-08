from dataclasses import dataclass
from typing import Iterable, Optional


@dataclass(frozen=True)
class Metrics:
    income_cents: int
    expense_cents: int
    profit_cents: int
    profitability_percent: Optional[float]


def calculate_metrics(incomes: Iterable[int], expenses: Iterable[int]) -> Metrics:
    """Calculate project metrics using integer cents to avoid floating-point money errors.

    Profitability is calculated as profit / expenses * 100%.
    When expenses are zero, profitability is undefined and returned as None.
    """
    income_cents = sum(incomes)
    expense_cents = sum(expenses)
    profit_cents = income_cents - expense_cents
    profitability = None if expense_cents == 0 else round(profit_cents / expense_cents * 100, 2)
    return Metrics(
        income_cents=income_cents,
        expense_cents=expense_cents,
        profit_cents=profit_cents,
        profitability_percent=profitability,
    )
