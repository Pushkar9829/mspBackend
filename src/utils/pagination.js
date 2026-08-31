export function paginate(query = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

export function paginated(data, total, { page, limit }) {
  return {
    data,
    meta: {
      total,
      page,
      limit,
      pages: Math.ceil(total / limit) || 0,
    },
  };
}
