import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import sharp from "sharp";
import { v2 as cloudinary } from "cloudinary";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_item_photos_test";
delete process.env.CLOUDINARY_URL;

const { pool } = await import("../lib/db.js");
const {
  ITEM_PHOTO_MAX_EDGE,
  ITEM_PHOTO_MAX_INCOMING_BYTES,
  ITEM_PHOTO_UPLOADS_PER_WINDOW,
  resetItemPhotosForTests,
  setPhotoStorageForTests,
  sniffPhoto,
} = await import("../lib/itemPhotos.js");
const { deleteItemPhoto, getItemPhoto, uploadItemPhoto } = await import(
  "../api-functions/itemPhotos.js"
);
const { getItemById } = await import("../api-functions/items.js");

const SECRET = "unit-test-secret";
const COLUMNS = [
  "image_public_id",
  "image_width",
  "image_height",
  "image_bytes",
  "image_format",
];

pool.options.connectionTimeoutMillis = 500;

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    end(payload) {
      this.ended = payload;
      return this;
    },
  };
}

function photoRequest(buffer, headers = {}) {
  const chunks = [buffer];
  return {
    auth: { clientId: 4, userId: 9 },
    params: { id: "10" },
    headers: {
      "content-type": "image/jpeg",
      "content-length": String(buffer.length),
      ...headers,
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function installStorage() {
  const calls = { uploads: [], destroyed: [], downloads: [] };
  setPhotoStorageForTests({
    async upload(buffer, publicId) {
      calls.uploads.push({ bytes: buffer.length, publicId });
      const meta = await sharp(buffer).metadata();
      return {
        public_id: publicId,
        resource_type: "image",
        format: "webp",
        width: meta.width,
        height: meta.height,
        bytes: buffer.length,
      };
    },
    async destroy(publicId) {
      calls.destroyed.push(publicId);
      return { result: "ok" };
    },
    async download(publicId) {
      calls.downloads.push(publicId);
      return Buffer.from("webp-bytes");
    },
  });
  return calls;
}

function installDb({ item = { id: 10, image_public_id: null }, columns = true, failUpdate = false } = {}) {
  const queries = [];
  pool.query = async (sql, params = []) => {
    const text = String(sql);
    queries.push({ sql: text, params });
    if (text.includes("information_schema.columns")) {
      return { rows: columns ? COLUMNS.map((column_name) => ({ column_name })) : [] };
    }
    if (text.includes("UPDATE items") && text.includes("image_public_id = $1")) {
      if (failUpdate) throw new Error("db down");
      return {
        rows: [
          {
            id: 10,
            image_public_id: params[0],
            image_width: params[1],
            image_height: params[2],
            image_bytes: params[3],
            image_format: params[4],
          },
        ],
      };
    }
    if (text.includes("UPDATE items")) return { rows: [], rowCount: 1 };
    if (text.includes("FROM items")) return { rows: item ? [item] : [] };
    throw new Error(text);
  };
  return queries;
}

async function jpeg(width, height) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 80, b: 40 } },
  })
    .jpeg()
    .toBuffer();
}

after(() => {
  resetItemPhotosForTests();
});

describe("item photo gateway", { concurrency: 1 }, () => {
  it("keeps the proposed columns unapplied", () => {
    const sql = readFileSync(new URL("../scripts/sql/item-photos.sql", import.meta.url), "utf8");
    assert.match(sql, /Do not run until Luna approves/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS image_public_id TEXT/);
    assert.equal(sql.includes("ALTER TABLE users"), false);
    assert.equal(sql.includes("ALTER TABLE clients"), false);
  });

  it("does not rely on a signed field Cloudinary will not enforce", () => {
    const secret = SECRET;
    const params = {
      public_id: "c/4/items/10/abc",
      timestamp: 1700000000,
      type: "authenticated",
      transformation: "c_limit,h_1600,w_1600/f_webp/q_75",
    };
    const signed = cloudinary.utils.api_sign_request(params, secret);
    const extraResourceType = cloudinary.utils.api_sign_request(
      { ...params, resource_type: "raw" },
      secret
    );
    assert.notEqual(signed, extraResourceType);
    assert.equal(Object.hasOwn(params, "max_file_size"), false);
    assert.equal(Object.hasOwn(params, "resource_type"), false);
  });

  it("resizes a wide photo before upload and does not let the client choose the id", async () => {
    resetItemPhotosForTests();
    const calls = installStorage();
    const queries = installDb();
    const res = mockRes();
    await uploadItemPhoto(photoRequest(await jpeg(2400, 800)), res);

    assert.equal(res.statusCode, 200);
    assert.equal(calls.uploads.length, 1);
    assert.match(calls.uploads[0].publicId, /^c\/4\/items\/10\/[a-f0-9]{32}$/);
    assert.ok(calls.uploads[0].bytes <= 500 * 1024);
    const stored = await sharp(await jpeg(2400, 800)).metadata();
    assert.ok(stored.width > ITEM_PHOTO_MAX_EDGE);
    assert.ok(res.body.photo.width <= ITEM_PHOTO_MAX_EDGE);
    assert.ok(res.body.photo.height <= ITEM_PHOTO_MAX_EDGE);
    assert.equal(res.body.photo.format, "webp");
    assert.equal(res.body.photo.url, undefined);
    assert.equal(JSON.stringify(res.body).includes(SECRET), false);
    const update = queries.find((query) => query.sql.includes("image_public_id = $1"));
    assert.equal(/name\s*=/.test(update.sql), false);
    assert.equal(update.params[6], 4);
    assert.equal(calls.destroyed.length, 0);
  });

  it("rejects an original that is too large or not a photo before upload", async () => {
    resetItemPhotosForTests();
    const calls = installStorage();
    installDb();
    const huge = mockRes();
    const pulled = { n: 0 };
    await uploadItemPhoto(
      {
        ...photoRequest(Buffer.from("nope"), {
          "content-length": String(ITEM_PHOTO_MAX_INCOMING_BYTES + 1),
        }),
        async *[Symbol.asyncIterator]() {
          pulled.n += 1;
          yield Buffer.from("nope");
        },
      },
      huge
    );
    assert.equal(huge.statusCode, 400);
    assert.equal(huge.body.code, "PHOTO_TOO_LARGE");
    assert.equal(pulled.n, 0);
    assert.equal(calls.uploads.length, 0);

    const junk = mockRes();
    await uploadItemPhoto(photoRequest(Buffer.from("not-a-photo-file!!")), junk);
    assert.equal(junk.statusCode, 400);
    assert.equal(junk.body.code, "PHOTO_INVALID");
    assert.equal(calls.uploads.length, 0);
    const heic = Buffer.alloc(16);
    heic.write("ftyp", 4, "ascii");
    heic.write("heic", 8, "ascii");
    assert.equal(sniffPhoto(heic), "heic");
    assert.equal(sniffPhoto(Buffer.from("not-a-photo-file!!")), null);
  });

  it("drops a new upload when the database save fails and keeps the previous photo", async () => {
    resetItemPhotosForTests();
    const calls = installStorage();
    const previous = "c/4/items/10/" + "a".repeat(32);
    installDb({ item: { id: 10, image_public_id: previous }, failUpdate: true });
    const res = mockRes();
    await uploadItemPhoto(photoRequest(await jpeg(20, 20)), res);
    assert.equal(res.statusCode, 500);
    assert.equal(calls.uploads.length, 1);
    assert.deepEqual(calls.destroyed, [calls.uploads[0].publicId]);
    assert.equal(calls.destroyed.includes(previous), false);
  });

  it("replaces a photo only after the new row is saved", async () => {
    resetItemPhotosForTests();
    const calls = installStorage();
    const previous = "c/4/items/10/" + "b".repeat(32);
    installDb({ item: { id: 10, image_public_id: previous } });
    const res = mockRes();
    await uploadItemPhoto(photoRequest(await jpeg(30, 30)), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls.destroyed, [previous]);
    assert.notEqual(calls.destroyed[0], calls.uploads[0].publicId);
  });

  it("does not delete a stored id that is not this item's", async () => {
    resetItemPhotosForTests();
    const calls = installStorage();
    const queries = installDb({
      item: { id: 10, image_public_id: "c/9/items/10/" + "c".repeat(32) },
    });
    const res = mockRes();
    await deleteItemPhoto(
      { auth: { clientId: 4, userId: 9 }, params: { id: "10" } },
      res
    );
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, "PHOTO_WRONG_ITEM");
    assert.deepEqual(calls.destroyed, []);
    assert.equal(
      queries.some((query) => query.sql.includes("image_public_id = NULL")),
      false
    );
  });

  it("serves a photo only through the authenticated route and does not store it as public", async () => {
    resetItemPhotosForTests();
    const calls = installStorage();
    const publicId = "c/4/items/10/" + "d".repeat(32);
    installDb({
      item: { id: 10, image_public_id: publicId, image_format: "webp" },
    });
    const res = mockRes();
    await getItemPhoto({ auth: { clientId: 4, userId: 9 }, params: { id: "10" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers["cache-control"], "private, no-store");
    assert.equal(res.headers["content-type"], "image/webp");
    assert.equal(Buffer.compare(res.ended, Buffer.from("webp-bytes")), 0);
    assert.deepEqual(calls.downloads, [publicId]);
    assert.equal(JSON.stringify(res.headers).includes("res.cloudinary.com"), false);

    pool.query = async (sql) => {
      if (String(sql).includes("information_schema")) return { rows: [] };
      return {
        rows: [
          {
            id: 10,
            name: "Soap",
            image_public_id: publicId,
            image_width: 800,
            image_height: 600,
            image_bytes: 1000,
            image_format: "webp",
          },
        ],
      };
    };
    const item = mockRes();
    await getItemById({ auth: { clientId: 4 }, params: { id: "10" } }, item);
    assert.equal(item.body.image_public_id, undefined);
    assert.equal(item.body.photo.url, undefined);
    assert.equal(item.body.photo.width, 800);
    assert.equal(JSON.stringify(item.body).includes(SECRET), false);
  });

  it("limits uploads in this process only", async () => {
    resetItemPhotosForTests();
    installStorage();
    installDb();
    const body = await jpeg(8, 8);
    for (let n = 0; n < ITEM_PHOTO_UPLOADS_PER_WINDOW; n += 1) {
      const res = mockRes();
      await uploadItemPhoto(photoRequest(body), res);
      assert.equal(res.statusCode, 200);
    }
    const limited = mockRes();
    await uploadItemPhoto(photoRequest(body), limited);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.body.code, "PHOTO_RATE_LIMITED");
  });
});
