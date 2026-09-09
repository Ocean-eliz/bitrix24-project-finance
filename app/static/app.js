const state = {
  projects: [],
  categories: [],
  employees: [],
  selectedProjectId: null,
  currentEmployee: null,
  b24User: null,
};

const el = (id) => document.getElementById(id);

const fmtMoney = (cents) =>
  new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 2,
  }).format(cents / 100);

const fmtPercent = (value) =>
  value == null
    ? '—'
    : `${new Intl.NumberFormat('ru-RU', {
        maximumFractionDigits: 2,
      }).format(value)}%`;

const initials = (name = '?') =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0])
    .join('')
    .toUpperCase();

const esc = (value = '') =>
  String(value).replace(/[&<>'"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[c]);

async function api(url, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (state.currentEmployee?.id) {
    headers['X-Employee-Id'] = String(state.currentEmployee.id);
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  if (!response.ok) {
    let message = 'Ошибка запроса';

    try {
      const body = await response.json();
      message = body.detail || message;
    } catch (_) {}

    throw new Error(
      Array.isArray(message)
        ? message.map((x) => x.msg).join(', ')
        : message,
    );
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function toast(message, error = false) {
  const node = el('toast');

  if (!node) {
    console.log(message);
    return;
  }

  node.textContent = message;
  node.classList.toggle('error', error);
  node.classList.remove('hidden');

  setTimeout(() => {
    node.classList.add('hidden');
  }, 2700);
}

async function initBitrix() {
  if (!window.BX24) {
    return false;
  }

  return new Promise((resolve) => {
    let done = false;

    const finish = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };

    const timeout = setTimeout(() => {
      finish(false);
    }, 3000);

    try {
      BX24.init(() => {
        try {
          BX24.callMethod('app.info', {}, (appInfo) => {
            try {
              if (!appInfo.error()) {
                const info = appInfo.data();

                if (info && info.INSTALLED === false) {
                  BX24.installFinish();
                }
              }
            } catch (_) {}
          });
        } catch (_) {}

        BX24.callMethod('user.current', {}, async (result) => {
          clearTimeout(timeout);

          if (result.error()) {
            return finish(false);
          }

          const user = result.data();
          state.b24User = user;

          try {
            state.currentEmployee = await api('/api/employees/sync', {
              method: 'POST',
              body: JSON.stringify({
                external_id: String(user.ID),
                name:
                  [user.NAME, user.LAST_NAME]
                    .filter(Boolean)
                    .join(' ') || `Пользователь ${user.ID}`,
                email: user.EMAIL || null,
              }),
            });

            const userPill = el('userPill');
            const integrationStatus = el('integrationStatus');

            if (userPill) {
              userPill.textContent = state.currentEmployee.name;
            }

            if (integrationStatus) {
              integrationStatus.textContent =
                'Работаем внутри Битрикс24';
            }

            try {
              BX24.fitWindow();
            } catch (_) {}
          } catch (error) {
            console.error('Ошибка синхронизации пользователя:', error);
          }

          finish(true);
        });
      });
    } catch (_) {
      clearTimeout(timeout);
      finish(false);
    }
  });
}

async function syncBitrixUsers() {
  if (!state.b24User || !window.BX24) {
    return;
  }

  await new Promise((resolve) => {
    try {
      BX24.callMethod(
        'user.get',
        { ACTIVE: true },
        async (result) => {
          if (!result.error()) {
            const users = result.data().slice(0, 50);

            for (const user of users) {
              try {
                await api('/api/employees/sync', {
                  method: 'POST',
                  body: JSON.stringify({
                    external_id: String(user.ID),
                    name:
                      [user.NAME, user.LAST_NAME]
                        .filter(Boolean)
                        .join(' ') || `Пользователь ${user.ID}`,
                    email: user.EMAIL || null,
                  }),
                });
              } catch (_) {}
            }
          }

          resolve();
        },
      );
    } catch (_) {
      resolve();
    }
  });
}

async function refreshData() {
  [
    state.projects,
    state.categories,
    state.employees,
  ] = await Promise.all([
    api('/api/projects'),
    api('/api/categories'),
    api('/api/employees'),
  ]);

  renderProjects();
  renderCategories();
  fillEmployeeSelects();
}

function renderPortfolio() {
  const total = state.projects.reduce(
    (acc, project) => {
      acc.income += project.metrics.income_cents;
      acc.expense += project.metrics.expense_cents;
      return acc;
    },
    {
      income: 0,
      expense: 0,
    },
  );

  const profit = total.income - total.expense;

  const profitability =
    total.expense === 0
      ? null
      : Math.round(
          (profit / total.expense) * 100 * 100,
        ) / 100;

  el('portfolioSummary').innerHTML = `
    ${metricCard(
      'Доходы',
      fmtMoney(total.income),
      'income',
    )}

    ${metricCard(
      'Расходы',
      fmtMoney(total.expense),
      'expense',
    )}

    ${metricCard(
      'Прибыль',
      fmtMoney(profit),
      `profit ${profit < 0 ? 'negative' : ''}`,
    )}

    ${metricCard(
      'Рентабельность',
      fmtPercent(profitability),
      '',
    )}
  `;
}

function metricCard(label, value, cls) {
  return `
    <div class="metric-card ${cls}">
      <span class="metric-label">${label}</span>
      <strong class="metric-value">${value}</strong>
    </div>
  `;
}

function renderProjects() {
  renderPortfolio();

  const grid = el('projectGrid');
  const empty = el('projectsEmpty');

  empty.classList.toggle(
    'hidden',
    state.projects.length !== 0,
  );

  grid.classList.toggle(
    'hidden',
    state.projects.length === 0,
  );

  grid.innerHTML = state.projects
    .map((project) => {
      const metrics = project.metrics;

      const avatars = project.employees
        .slice(0, 4)
        .map(
          (employee) => `
            <div
              class="avatar"
              title="${esc(employee.name)}"
            >
              ${esc(initials(employee.name))}
            </div>
          `,
        )
        .join('');

      return `
        <article
          class="project-card ${
            state.selectedProjectId === project.id
              ? 'active'
              : ''
          }"
          data-project-id="${project.id}"
        >
          <div class="project-card-head">
            <div>
              <h3>${esc(project.name)}</h3>

              <div class="desc">
                ${esc(
                  project.description || 'Без описания',
                )}
              </div>
            </div>

            <span>›</span>
          </div>

          <div class="project-kpis">
            <div class="project-kpi">
              <span>Прибыль</span>
              <strong>
                ${fmtMoney(metrics.profit_cents)}
              </strong>
            </div>

            <div class="project-kpi">
              <span>Рентабельность</span>
              <strong>
                ${fmtPercent(
                  metrics.profitability_percent,
                )}
              </strong>
            </div>
          </div>

          <div class="avatars">
            ${
              avatars ||
              '<span class="desc">Команда не назначена</span>'
            }
          </div>
        </article>
      `;
    })
    .join('');

  grid
    .querySelectorAll('[data-project-id]')
    .forEach((card) => {
      card.addEventListener('click', () => {
        openProject(
          Number(card.dataset.projectId),
        );
      });
    });
}

async function openProject(projectId) {
  state.selectedProjectId = projectId;

  const [project, transactions] =
    await Promise.all([
      api(`/api/projects/${projectId}`),
      api(
        `/api/projects/${projectId}/transactions`,
      ),
    ]);

  renderProjects();

  const detail = el('projectDetail');
  detail.classList.remove('hidden');

  const metrics = project.metrics;

  detail.innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${esc(project.name)}</h2>
        <p>
          ${esc(
            project.description || 'Без описания',
          )}
        </p>
      </div>

      <div class="detail-actions">
        <button
          class="btn danger small"
          id="deleteProjectBtn"
        >
          Удалить проект
        </button>

        <button
          class="btn primary"
          id="addTransactionBtn"
        >
          + Операция
        </button>
      </div>
    </div>

    <div class="summary-grid detail-metrics">
      ${metricCard(
        'Доходы',
        fmtMoney(metrics.income_cents),
        'income',
      )}

      ${metricCard(
        'Расходы',
        fmtMoney(metrics.expense_cents),
        'expense',
      )}

      ${metricCard(
        'Прибыль',
        fmtMoney(metrics.profit_cents),
        `profit ${
          metrics.profit_cents < 0
            ? 'negative'
            : ''
        }`,
      )}

      ${metricCard(
        'Рентабельность',
        fmtPercent(
          metrics.profitability_percent,
        ),
        '',
      )}
    </div>

    <div class="detail-grid">
      <div class="panel">
        <div class="panel-head">
          <h3>Операции</h3>

          <span class="badge">
            ${transactions.length}
          </span>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Статья</th>
                <th>Комментарий</th>
                <th>Сумма</th>
                <th>Действия</th>
              </tr>
            </thead>

            <tbody>
              ${
                transactions.length
                  ? transactions
                      .map(
                        (transaction) => `
                          <tr>
                            <td>
                              ${esc(
                                transaction.operation_date,
                              )}
                            </td>

                            <td>
                              ${esc(
                                transaction.category_name,
                              )}
                            </td>

                            <td>
                              ${esc(
                                transaction.comment ||
                                  '—',
                              )}
                            </td>

                            <td
                              class="${
                                transaction.kind ===
                                'income'
                                  ? 'amount-income'
                                  : 'amount-expense'
                              }"
                            >
                              ${
                                transaction.kind ===
                                'income'
                                  ? '+'
                                  : '−'
                              }

                              ${fmtMoney(
                                transaction.amount_cents,
                              )}
                            </td>

                            <td>
                              <button
                                class="row-delete"
                                data-delete-transaction="${
                                  transaction.id
                                }"
                                title="Удалить операцию"
                              >
                                Удалить
                              </button>
                            </td>
                          </tr>
                        `,
                      )
                      .join('')
                  : `
                    <tr>
                      <td
                        colspan="5"
                        class="empty-row"
                      >
                        Операций пока нет
                      </td>
                    </tr>
                  `
              }
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h3>Команда проекта</h3>

          <button
            class="btn ghost small"
            id="addEmployeeBtn"
          >
            + Добавить
          </button>
        </div>

        <div class="team-list">
          ${
            project.employees.length
              ? project.employees
                  .map(
                    (employee) => `
                      <div class="team-person">
                        <div class="team-avatar">
                          ${esc(
                            initials(employee.name),
                          )}
                        </div>

                        <div class="team-meta">
                          <strong>
                            ${esc(employee.name)}
                          </strong>

                          <span>
                            ${esc(
                              employee.email ||
                                'Сотрудник',
                            )}
                          </span>
                        </div>

                        <button
                          class="remove-person"
                          data-remove-employee="${
                            employee.id
                          }"
                          title="Убрать из проекта"
                        >
                          ×
                        </button>
                      </div>
                    `,
                  )
                  .join('')
              : `
                <div class="empty-row">
                  Сотрудники не добавлены
                </div>
              `
          }
        </div>
      </div>
    </div>
  `;

  detail.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  });

  el('addTransactionBtn').onclick = () => {
    openTransactionModal(projectId);
  };

  el('addEmployeeBtn').onclick = () => {
    openEmployeeModal(
      projectId,
      project.employees.map(
        (employee) => employee.id,
      ),
    );
  };

  el('deleteProjectBtn').onclick = () => {
    deleteProject(
      projectId,
      project.name,
    );
  };

  detail
    .querySelectorAll(
      '[data-delete-transaction]',
    )
    .forEach((button) => {
      button.onclick = () => {
        deleteTransaction(
          Number(
            button.dataset.deleteTransaction,
          ),
          projectId,
        );
      };
    });

  detail
    .querySelectorAll(
      '[data-remove-employee]',
    )
    .forEach((button) => {
      button.onclick = () => {
        removeEmployee(
          projectId,
          Number(
            button.dataset.removeEmployee,
          ),
        );
      };
    });
}

function renderCategories() {
  const groups = [
    [
      'income',
      'Доходы',
      'Статьи поступлений по проектам',
    ],
    [
      'expense',
      'Расходы',
      'Статьи затрат по проектам',
    ],
  ];

  el('categoryColumns').innerHTML =
    groups
      .map(
        ([
          kind,
          title,
          subtitle,
        ]) => {
          const items =
            state.categories.filter(
              (category) =>
                category.kind === kind,
            );

          return `
            <div class="category-card">
              <h3>${title}</h3>

              <p class="desc">
                ${subtitle}
              </p>

              <div class="category-list">
                ${items
                  .map(
                    (category) => `
                      <div class="category-row">
                        <span>
                          ${esc(
                            category.name,
                          )}
                        </span>

                        <span
                          class="badge ${
                            category.is_system
                              ? ''
                              : 'custom'
                          }"
                        >
                          ${
                            category.is_system
                              ? 'системная'
                              : 'пользовательская'
                          }
                        </span>
                      </div>
                    `,
                  )
                  .join('')}
              </div>
            </div>
          `;
        },
      )
      .join('');
}

function fillEmployeeSelects() {
  const select =
    el('projectEmployeeSelect');

  if (!select) {
    return;
  }

  select.innerHTML =
    state.employees
      .map(
        (employee) => `
          <option value="${employee.id}">
            ${esc(employee.name)}
            ${
              employee.email
                ? ` — ${esc(
                    employee.email,
                  )}`
                : ''
            }
          </option>
        `,
      )
      .join('');
}

function openModal(id) {
  el(id).classList.remove('hidden');
}

function closeModal(id) {
  el(id).classList.add('hidden');
}

function openTransactionModal(projectId) {
  const form =
    el('transactionForm');

  form.project_id.value =
    projectId;

  form.operation_date.valueAsDate =
    new Date();

  el('transactionCategory').innerHTML = `
    <optgroup label="Доходы">
      ${state.categories
        .filter(
          (category) =>
            category.kind === 'income',
        )
        .map(
          (category) => `
            <option value="${category.id}">
              ${esc(category.name)}
            </option>
          `,
        )
        .join('')}
    </optgroup>

    <optgroup label="Расходы">
      ${state.categories
        .filter(
          (category) =>
            category.kind === 'expense',
        )
        .map(
          (category) => `
            <option value="${category.id}">
              ${esc(category.name)}
            </option>
          `,
        )
        .join('')}
    </optgroup>
  `;

  openModal('transactionModal');
}

function openEmployeeModal(
  projectId,
  assignedIds,
) {
  const available =
    state.employees.filter(
      (employee) =>
        !assignedIds.includes(
          employee.id,
        ),
    );

  const form =
    el('employeeForm');

  form.project_id.value =
    projectId;

  el('employeeSelect').innerHTML =
    available.length
      ? available
          .map(
            (employee) => `
              <option value="${employee.id}">
                ${esc(employee.name)}
              </option>
            `,
          )
          .join('')
      : `
        <option disabled>
          Все сотрудники уже добавлены
        </option>
      `;

  form.querySelector(
    'button[type="submit"]',
  ).disabled =
    available.length === 0;

  openModal('employeeModal');
}

async function deleteTransaction(
  transactionId,
  projectId,
) {
  if (
    !confirm(
      'Удалить эту операцию?',
    )
  ) {
    return;
  }

  try {
    await api(
      `/api/transactions/${transactionId}`,
      {
        method: 'DELETE',
      },
    );

    await refreshData();
    await openProject(projectId);

    toast('Операция удалена');
  } catch (error) {
    toast(error.message, true);
  }
}

async function removeEmployee(
  projectId,
  employeeId,
) {
  try {
    await api(
      `/api/projects/${projectId}/employees/${employeeId}`,
      {
        method: 'DELETE',
      },
    );

    await refreshData();
    await openProject(projectId);

    toast(
      'Сотрудник убран из проекта',
    );
  } catch (error) {
    toast(error.message, true);
  }
}

async function deleteProject(
  projectId,
  name,
) {
  if (
    !confirm(
      `Удалить проект «${name}» вместе со всеми операциями?`,
    )
  ) {
    return;
  }

  try {
    await api(
      `/api/projects/${projectId}`,
      {
        method: 'DELETE',
      },
    );

    state.selectedProjectId =
      null;

    el('projectDetail')
      .classList.add('hidden');

    await refreshData();

    toast('Проект удалён');
  } catch (error) {
    toast(error.message, true);
  }
}

function bindForms() {
  const projectForm =
    el('projectForm');

  const categoryForm =
    el('categoryForm');

  const transactionForm =
    el('transactionForm');

  const employeeForm =
    el('employeeForm');

  projectForm.addEventListener(
    'submit',
    async (event) => {
      event.preventDefault();

      const formElement =
        event.target;

      const form =
        new FormData(
          formElement,
        );

      const employeeIds = [
        ...el(
          'projectEmployeeSelect',
        ).selectedOptions,
      ].map(
        (option) =>
          Number(option.value),
      );

      try {
        const project =
          await api(
            '/api/projects',
            {
              method: 'POST',
              body: JSON.stringify({
                name:
                  form.get('name'),
                description:
                  form.get(
                    'description',
                  ),
                employee_ids:
                  employeeIds,
              }),
            },
          );

        formElement.reset();

        closeModal(
          'projectModal',
        );

        await refreshData();

        await openProject(
          project.id,
        );

        toast(
          'Проект создан',
        );
      } catch (error) {
        toast(
          error.message,
          true,
        );
      }
    },
  );

  categoryForm.addEventListener(
    'submit',
    async (event) => {
      event.preventDefault();

      const formElement =
        event.target;

      const form =
        new FormData(
          formElement,
        );

      try {
        await api(
          '/api/categories',
          {
            method: 'POST',
            body: JSON.stringify({
              name:
                form.get('name'),
              kind:
                form.get('kind'),
            }),
          },
        );

        formElement.reset();

        closeModal(
          'categoryModal',
        );

        await refreshData();

        toast(
          'Статья добавлена',
        );
      } catch (error) {
        toast(
          error.message,
          true,
        );
      }
    },
  );

  transactionForm.addEventListener(
    'submit',
    async (event) => {
      event.preventDefault();

      const formElement =
        event.target;

      const form =
        new FormData(
          formElement,
        );

      const projectId =
        Number(
          form.get(
            'project_id',
          ),
        );

      try {
        await api(
          `/api/projects/${projectId}/transactions`,
          {
            method: 'POST',
            body: JSON.stringify({
              category_id:
                Number(
                  form.get(
                    'category_id',
                  ),
                ),
              amount:
                form.get(
                  'amount',
                ),
              operation_date:
                form.get(
                  'operation_date',
                ),
              comment:
                form.get(
                  'comment',
                ),
            }),
          },
        );

        formElement.reset();

        closeModal(
          'transactionModal',
        );

        await refreshData();

        await openProject(
          projectId,
        );

        toast(
          'Операция добавлена',
        );
      } catch (error) {
        toast(
          error.message,
          true,
        );
      }
    },
  );

  employeeForm.addEventListener(
    'submit',
    async (event) => {
      event.preventDefault();

      const formElement =
        event.target;

      const form =
        new FormData(
          formElement,
        );

      const projectId =
        Number(
          form.get(
            'project_id',
          ),
        );

      try {
        await api(
          `/api/projects/${projectId}/employees`,
          {
            method: 'POST',
            body: JSON.stringify({
              employee_id:
                Number(
                  form.get(
                    'employee_id',
                  ),
                ),
            }),
          },
        );

        formElement.reset();

        closeModal(
          'employeeModal',
        );

        await refreshData();

        await openProject(
          projectId,
        );

        toast(
          'Сотрудник добавлен',
        );
      } catch (error) {
        toast(
          error.message,
          true,
        );
      }
    },
  );
}

function bindNavigation() {
  document
    .querySelectorAll(
      '.nav-item',
    )
    .forEach((button) => {
      button.addEventListener(
        'click',
        () => {
          document
            .querySelectorAll(
              '.nav-item',
            )
            .forEach(
              (item) => {
                item.classList.remove(
                  'active',
                );
              },
            );

          button.classList.add(
            'active',
          );

          const projects =
            button.dataset.view ===
            'projects';

          el(
            'projectsView',
          ).classList.toggle(
            'hidden',
            !projects,
          );

          el(
            'categoriesView',
          ).classList.toggle(
            'hidden',
            projects,
          );

          el(
            'newProjectBtn',
          ).classList.toggle(
            'hidden',
            !projects,
          );

          el(
            'pageTitle',
          ).textContent =
            projects
              ? 'Экономика проектов'
              : 'Справочник статей';

          el(
            'pageSubtitle',
          ).textContent =
            projects
              ? 'Доходы, расходы и рентабельность в одном месте'
              : 'Управление статьями доходов и расходов';
        },
      );
    });

  el(
    'newProjectBtn',
  ).onclick = () => {
    openModal(
      'projectModal',
    );
  };

  el(
    'newCategoryBtn',
  ).onclick = () => {
    openModal(
      'categoryModal',
    );
  };

  document
    .querySelectorAll(
      '[data-close]',
    )
    .forEach((button) => {
      button.onclick = () => {
        closeModal(
          button.dataset.close,
        );
      };
    });

  document
    .querySelectorAll(
      '.modal-backdrop',
    )
    .forEach((backdrop) => {
      backdrop.addEventListener(
        'click',
        (event) => {
          if (
            event.target ===
            backdrop
          ) {
            closeModal(
              backdrop.id,
            );
          }
        },
      );
    });

  document
    .querySelectorAll(
      '[data-action="open-project-modal"]',
    )
    .forEach((button) => {
      button.onclick = () => {
        openModal(
          'projectModal',
        );
      };
    });
}

(async function bootstrap() {
  bindNavigation();
  bindForms();

  const inBitrix =
    await initBitrix();

  const integrationStatus =
    el('integrationStatus');

  if (
    !inBitrix &&
    integrationStatus
  ) {
    integrationStatus.textContent =
      'Демо-режим вне Битрикс24';
  }

  if (inBitrix) {
    await syncBitrixUsers();
  }

  try {
    await refreshData();
  } catch (error) {
    toast(
      `Не удалось загрузить данные: ${error.message}`,
      true,
    );
  }
})();
