import { Router } from "express";

function parseId(param) {
  const id = Number(param);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function createCrudRouter(h) {
  const r = Router();

  r.get("/", (req, res, next) => {
    void h
      .list()
      .then((rows) => res.json(rows))
      .catch(next);
  });

  r.get("/:id", (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    void h
      .getById(id)
      .then((row) => {
        if (!row) {
          res.status(404).json({ error: "Not found" });
          return;
        }
        res.json(row);
      })
      .catch(next);
  });

  r.post("/", (req, res, next) => {
    void h
      .create(req.body)
      .then((row) => res.status(201).json(row))
      .catch(next);
  });

  r.put("/:id", (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    void h
      .update(id, req.body)
      .then((row) => {
        if (!row) {
          res.status(404).json({ error: "Not found" });
          return;
        }
        res.json(row);
      })
      .catch(next);
  });

  r.patch("/:id", (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    void h
      .update(id, req.body)
      .then((row) => {
        if (!row) {
          res.status(404).json({ error: "Not found" });
          return;
        }
        res.json(row);
      })
      .catch(next);
  });

  r.delete("/:id", (req, res, next) => {
    const id = parseId(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }
    void h
      .remove(id)
      .then((ok) => {
        if (!ok) {
          res.status(404).end();
          return;
        }
        res.status(204).end();
      })
      .catch(next);
  });

  return r;
}
