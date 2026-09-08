import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

BASE_DIR = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.getenv("APP_DB_PATH", BASE_DIR / "data" / "finance.db"))

DEFAULT_CATEGORIES = [
    ("Доход от проекта", "income", 1),
    ("Внешние программисты", "expense", 1),
    ("Внутренние программисты", "expense", 1),
    ("Расходы на ИИ", "expense", 1),
    ("Аренда сервера", "expense", 1),
    ("Дивиденды", "expense", 1),
]


@contextmanager
def get_connection() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with get_connection() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS employees (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                external_id TEXT UNIQUE,
                name TEXT NOT NULL,
                email TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS project_employees (
                project_id INTEGER NOT NULL,
                employee_id INTEGER NOT NULL,
                PRIMARY KEY (project_id, employee_id),
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                kind TEXT NOT NULL CHECK (kind IN ('income', 'expense')),
                is_system INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(name, kind)
            );

            CREATE TABLE IF NOT EXISTS transactions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id INTEGER NOT NULL,
                category_id INTEGER NOT NULL,
                amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
                operation_date TEXT NOT NULL,
                comment TEXT NOT NULL DEFAULT '',
                created_by_employee_id INTEGER,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
                FOREIGN KEY (category_id) REFERENCES categories(id),
                FOREIGN KEY (created_by_employee_id) REFERENCES employees(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_transactions_project_id ON transactions(project_id);
            CREATE INDEX IF NOT EXISTS idx_transactions_operation_date ON transactions(operation_date);
            CREATE INDEX IF NOT EXISTS idx_project_employees_employee_id ON project_employees(employee_id);
            """
        )

        conn.executemany(
            "INSERT OR IGNORE INTO categories(name, kind, is_system) VALUES (?, ?, ?)",
            DEFAULT_CATEGORIES,
        )

        seed_demo = os.getenv("APP_SEED_DEMO", "true").lower() in {"1", "true", "yes"}
        if seed_demo:
            _seed_demo(conn)


def _seed_demo(conn: sqlite3.Connection) -> None:
    existing = conn.execute("SELECT COUNT(*) AS cnt FROM projects").fetchone()["cnt"]
    if existing:
        return

    employees = [
        ("demo-1", "Анна Петрова", "anna@example.com"),
        ("demo-2", "Иван Смирнов", "ivan@example.com"),
        ("demo-3", "Мария Орлова", "maria@example.com"),
    ]
    conn.executemany(
        "INSERT OR IGNORE INTO employees(external_id, name, email) VALUES (?, ?, ?)", employees
    )

    cursor = conn.execute(
        "INSERT INTO projects(name, description) VALUES (?, ?)",
        ("Внедрение CRM", "Демонстрационный проект — можно удалить и создать свои данные."),
    )
    project_id = cursor.lastrowid

    employee_ids = [r["id"] for r in conn.execute("SELECT id FROM employees ORDER BY id LIMIT 2")]
    conn.executemany(
        "INSERT OR IGNORE INTO project_employees(project_id, employee_id) VALUES (?, ?)",
        [(project_id, employee_id) for employee_id in employee_ids],
    )

    category_map = {
        r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM categories")
    }
    transactions = [
        (project_id, category_map["Доход от проекта"], 450_000_00, "2026-09-01", "Первый этап работ"),
        (project_id, category_map["Внутренние программисты"], 140_000_00, "2026-09-02", "Команда разработки"),
        (project_id, category_map["Расходы на ИИ"], 35_000_00, "2026-09-03", "API и AI-инструменты"),
        (project_id, category_map["Аренда сервера"], 20_000_00, "2026-09-03", "Облачная инфраструктура"),
    ]
    conn.executemany(
        """
        INSERT INTO transactions(project_id, category_id, amount_cents, operation_date, comment)
        VALUES (?, ?, ?, ?, ?)
        """,
        transactions,
    )
