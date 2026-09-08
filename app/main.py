from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, Header, HTTPException, Query, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .db import get_connection, init_db
from .finance import calculate_metrics

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Bitrix24 Project Finance", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.on_event("startup")
def startup() -> None:
    init_db()



class ProjectCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    description: str = Field(default="", max_length=1000)
    employee_ids: list[int] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        value = value.strip()
        if len(value) < 2:
            raise ValueError("Название проекта слишком короткое")
        return value


class CategoryCreate(BaseModel):
    name: str = Field(min_length=2, max_length=100)
    kind: Literal["income", "expense"]

    @field_validator("name")
    @classmethod
    def strip_name(cls, value: str) -> str:
        return value.strip()


class EmployeeSync(BaseModel):
    external_id: str = Field(min_length=1, max_length=100)
    name: str = Field(min_length=1, max_length=160)
    email: Optional[str] = Field(default=None, max_length=200)


class ProjectEmployeeAdd(BaseModel):
    employee_id: int


class TransactionCreate(BaseModel):
    category_id: int
    amount: str = Field(description="Positive decimal amount, e.g. 12500.50")
    operation_date: date
    comment: str = Field(default="", max_length=500)

    @field_validator("amount")
    @classmethod
    def validate_amount(cls, value: str) -> str:
        from decimal import Decimal, InvalidOperation

        normalized = value.replace(" ", "").replace(",", ".")
        try:
            amount = Decimal(normalized)
        except InvalidOperation as exc:
            raise ValueError("Некорректная сумма") from exc
        if amount <= 0:
            raise ValueError("Сумма должна быть больше нуля")
        if amount.as_tuple().exponent < -2:
            raise ValueError("Допустимо не более двух знаков после запятой")
        return normalized


def amount_to_cents(amount: str) -> int:
    from decimal import Decimal, ROUND_HALF_UP

    return int((Decimal(amount) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def metrics_for_project(conn, project_id: int) -> dict:
    rows = conn.execute(
        """
        SELECT t.amount_cents, c.kind
        FROM transactions t
        JOIN categories c ON c.id = t.category_id
        WHERE t.project_id = ?
        """,
        (project_id,),
    ).fetchall()
    metrics = calculate_metrics(
        (row["amount_cents"] for row in rows if row["kind"] == "income"),
        (row["amount_cents"] for row in rows if row["kind"] == "expense"),
    )
    return {
        "income_cents": metrics.income_cents,
        "expense_cents": metrics.expense_cents,
        "profit_cents": metrics.profit_cents,
        "profitability_percent": metrics.profitability_percent,
    }


def project_payload(conn, project_row) -> dict:
    employees = [
        dict(row)
        for row in conn.execute(
            """
            SELECT e.id, e.external_id, e.name, e.email
            FROM employees e
            JOIN project_employees pe ON pe.employee_id = e.id
            WHERE pe.project_id = ?
            ORDER BY e.name
            """,
            (project_row["id"],),
        )
    ]
    return {
        **dict(project_row),
        "employees": employees,
        "metrics": metrics_for_project(conn, project_row["id"]),
    }


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/projects")
def list_projects():
    with get_connection() as conn:
        rows = conn.execute("SELECT id, name, description, created_at FROM projects ORDER BY id DESC").fetchall()
        return [project_payload(conn, row) for row in rows]


@app.post("/api/projects", status_code=201)
def create_project(payload: ProjectCreate):
    with get_connection() as conn:
        cursor = conn.execute(
            "INSERT INTO projects(name, description) VALUES (?, ?)",
            (payload.name, payload.description.strip()),
        )
        project_id = cursor.lastrowid
        if payload.employee_ids:
            valid_ids = {
                row["id"]
                for row in conn.execute(
                    f"SELECT id FROM employees WHERE id IN ({','.join('?' * len(payload.employee_ids))})",
                    payload.employee_ids,
                )
            }
            conn.executemany(
                "INSERT OR IGNORE INTO project_employees(project_id, employee_id) VALUES (?, ?)",
                [(project_id, employee_id) for employee_id in valid_ids],
            )
        row = conn.execute(
            "SELECT id, name, description, created_at FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        return project_payload(conn, row)


@app.delete("/api/projects/{project_id}", status_code=204)
def delete_project(project_id: int):
    with get_connection() as conn:
        cursor = conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        if cursor.rowcount == 0:
            raise HTTPException(404, "Проект не найден")
    return Response(status_code=204)


@app.get("/api/projects/{project_id}")
def get_project(project_id: int):
    with get_connection() as conn:
        row = conn.execute(
            "SELECT id, name, description, created_at FROM projects WHERE id = ?", (project_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Проект не найден")
        return project_payload(conn, row)


@app.get("/api/categories")
def list_categories(kind: Optional[Literal["income", "expense"]] = Query(default=None)):
    with get_connection() as conn:
        if kind:
            rows = conn.execute(
                "SELECT id, name, kind, is_system FROM categories WHERE kind = ? ORDER BY is_system DESC, name",
                (kind,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT id, name, kind, is_system FROM categories ORDER BY kind, is_system DESC, name"
            ).fetchall()
        return [dict(row) for row in rows]


@app.post("/api/categories", status_code=201)
def create_category(payload: CategoryCreate):
    with get_connection() as conn:
        try:
            cursor = conn.execute(
                "INSERT INTO categories(name, kind, is_system) VALUES (?, ?, 0)",
                (payload.name, payload.kind),
            )
        except Exception as exc:
            if "UNIQUE constraint failed" in str(exc):
                raise HTTPException(409, "Такая статья уже существует") from exc
            raise
        return {
            "id": cursor.lastrowid,
            "name": payload.name,
            "kind": payload.kind,
            "is_system": 0,
        }


@app.get("/api/employees")
def list_employees():
    with get_connection() as conn:
        rows = conn.execute(
            "SELECT id, external_id, name, email FROM employees ORDER BY name"
        ).fetchall()
        return [dict(row) for row in rows]


@app.post("/api/employees/sync")
def sync_employee(payload: EmployeeSync):
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO employees(external_id, name, email)
            VALUES (?, ?, ?)
            ON CONFLICT(external_id) DO UPDATE SET name = excluded.name, email = excluded.email
            """,
            (payload.external_id, payload.name.strip(), payload.email),
        )
        row = conn.execute(
            "SELECT id, external_id, name, email FROM employees WHERE external_id = ?",
            (payload.external_id,),
        ).fetchone()
        return dict(row)


@app.post("/api/projects/{project_id}/employees", status_code=201)
def add_employee(project_id: int, payload: ProjectEmployeeAdd):
    with get_connection() as conn:
        if not conn.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone():
            raise HTTPException(404, "Проект не найден")
        if not conn.execute("SELECT 1 FROM employees WHERE id = ?", (payload.employee_id,)).fetchone():
            raise HTTPException(404, "Сотрудник не найден")
        conn.execute(
            "INSERT OR IGNORE INTO project_employees(project_id, employee_id) VALUES (?, ?)",
            (project_id, payload.employee_id),
        )
        return {"status": "added"}


@app.delete("/api/projects/{project_id}/employees/{employee_id}", status_code=204)
def remove_employee(project_id: int, employee_id: int):
    with get_connection() as conn:
        conn.execute(
            "DELETE FROM project_employees WHERE project_id = ? AND employee_id = ?",
            (project_id, employee_id),
        )
    return Response(status_code=204)


@app.get("/api/projects/{project_id}/transactions")
def list_transactions(project_id: int):
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT t.id, t.amount_cents, t.operation_date, t.comment, t.created_at,
                   c.id AS category_id, c.name AS category_name, c.kind,
                   e.name AS created_by_name
            FROM transactions t
            JOIN categories c ON c.id = t.category_id
            LEFT JOIN employees e ON e.id = t.created_by_employee_id
            WHERE t.project_id = ?
            ORDER BY t.operation_date DESC, t.id DESC
            """,
            (project_id,),
        ).fetchall()
        return [dict(row) for row in rows]


@app.post("/api/projects/{project_id}/transactions", status_code=201)
def create_transaction(
    project_id: int,
    payload: TransactionCreate,
    x_employee_id: Optional[int] = Header(default=None),
):
    with get_connection() as conn:
        if not conn.execute("SELECT 1 FROM projects WHERE id = ?", (project_id,)).fetchone():
            raise HTTPException(404, "Проект не найден")
        category = conn.execute(
            "SELECT id, name, kind FROM categories WHERE id = ?", (payload.category_id,)
        ).fetchone()
        if not category:
            raise HTTPException(404, "Статья не найдена")
        if x_employee_id and not conn.execute(
            "SELECT 1 FROM employees WHERE id = ?", (x_employee_id,)
        ).fetchone():
            x_employee_id = None
        cursor = conn.execute(
            """
            INSERT INTO transactions(
                project_id, category_id, amount_cents, operation_date, comment, created_by_employee_id
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                project_id,
                payload.category_id,
                amount_to_cents(payload.amount),
                payload.operation_date.isoformat(),
                payload.comment.strip(),
                x_employee_id,
            ),
        )
        return {
            "id": cursor.lastrowid,
            "project_id": project_id,
            "category_id": category["id"],
            "category_name": category["name"],
            "kind": category["kind"],
            "amount_cents": amount_to_cents(payload.amount),
            "operation_date": payload.operation_date.isoformat(),
            "comment": payload.comment.strip(),
        }


@app.delete("/api/transactions/{transaction_id}", status_code=204)
def delete_transaction(transaction_id: int):
    with get_connection() as conn:
        cursor = conn.execute("DELETE FROM transactions WHERE id = ?", (transaction_id,))
        if cursor.rowcount == 0:
            raise HTTPException(404, "Операция не найдена")
    return Response(status_code=204)
