export function errorHandler(err, _req, res, next) {
  if (res.headersSent) {
    next(err);
    return;
  }
  const e = err;
  if (e.code === "23505") {
    res.status(409).json({ error: "Conflict", detail: e.message });
    return;
  }
  if (e.code === "23503") {
    res.status(400).json({ error: "Foreign key violation", detail: e.message });
    return;
  }
  if (e.statusCode === 400) {
    res.status(400).json({ error: e.message ?? "Bad request" });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
}
