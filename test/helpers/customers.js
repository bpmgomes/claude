/** Entrada válida do passo "Seus dados" (AF-04), com máscara e e-mail a normalizar. */
export function validCustomer(overrides = {}) {
  return { name: 'Ana Souza', phone: '(11) 91234-5678', email: 'Ana@Example.com ', ...overrides };
}

/** Quantidade de clientes de um negócio (ou de todos, sem `businessId`). */
export async function countCustomers(db, businessId) {
  const row = businessId
    ? await db.get('SELECT COUNT(*) AS n FROM customers WHERE business_id = ?', [businessId])
    : await db.get('SELECT COUNT(*) AS n FROM customers');
  return Number(row.n);
}
