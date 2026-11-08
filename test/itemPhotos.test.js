import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, it } from "node:test";
import { v2 as cloudinary } from "cloudinary";

process.env.DATABASE_URL ??=
  "postgres://user:pass@127.0.0.1:5432/upright_item_photos_test";
delete process.env.CLOUDINARY_URL;

const { pool } = await import("../lib/db.js");
const {
  ITEM_PHOTO_MAX_BYTES,
  ITEM_PHOTO_UPLOADS_PER_WINDOW,
  assessStoredPhoto,
  resetItemPhotosForTests,
  setPhotoStorageForTests,
  signatureMatches,
} = await import("../lib/itemPhotos.js");
const {
  createItemPhotoUpload,
  deleteItemPhoto,
  saveItemPhoto,
} = await import("../api-functions/itemPhotos.js");
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
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function req(body, extra = {}) {
  return {
    auth: { clientId: 4, userId: 9 },
    params: { id: "10" },
    body,
    ...extra,
  };
}

function installStorage(resource) {
  const calls = { fetched: [], destroyed: [] };
  setPhotoStorageForTests({
    config: {
      cloudName: "unit-test-cloud",
      apiKey: "unit-test-key",
      apiSecret: SECRET,
    },
    signUpload(params) {
      return cloudinary.utils.api_sign_request(params, SECRET);
    },
    deliveryUrl(publicId) {
      return `https://signed.example/${publicId}`;
    },
    async fetchResource(publicId) {
      calls.fetched.push(publicId);
      if (resource instanceof Error) throw resource;
      return resource;
    },
    async destroy(publicId) {
      calls.destroyed.push(publicId);
      return { result: "ok" };
    },
  });
  return calls;
}

function installDb({ item = { id: 10, image_public_id: null }, columns = true } = {}) {
  const queries = [];
  pool.query = async (sql, params = []) => {
    const text = String(sql);
    queries.push({ sql: text, params });
    if (text.includes("information_schema.columns")) {
      return {
        rows: columns ? COLUMNS.map((column_name) => ({ column_name })) : [],
      };
    }
    if (text.includes("UPDATE items")) {
      return {
        rows: [
          {
            id: 10,
            name: "Soap",
            sku: "should-stay",
            image_public_id: params[0],
            image_width: params[1],
            image_height: params[2],
            image_bytes: params[3],
            image_format: params[4],
          },
        ],
      };
    }
    if (text.includes("FROM items")) {
      return { rows: item ? [item] : [] };
    }
    throw new Error(text);
  };
  return queries;
}

function goodResource(overrides = {}) {
  return {
    resource_type: "image",
    format: "webp",
    width: 1600,
    height: 900,
    bytes: 180000,
    ...overrides,
  };
}

after(() => {
  resetItemPhotosForTests();
});

describe("item photos", { concurrency: 1 }, () => {
  it("proposes nullable item photo columns and does not run them", () => {
    const sql = readFileSync(
      new URL("../scripts/sql/item-photos.sql", import.meta.url),
      "utf8"
    );
    assert.match(sql, /ADD COLUMN IF NOT EXISTS image_public_id TEXT/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS image_width INTEGER/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS image_height INTEGER/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS image_bytes INTEGER/);
    assert.match(sql, /ADD COLUMN IF NOT EXISTS image_format TEXT/);
    assert.match(sql, /Do not run until Luna approves/);
    assert.equal(sql.includes("users"), false);
    assert.equal(sql.includes("clients"), false);
  });

  it("signs an authenticated upload for one item and hides the secret", async () => {
    resetItemPhotosForTests();
    installStorage(goodResource());
    installDb();
    const res = mockRes();
    await createItemPhotoUpload(req(), res);
    assert.equal(res.statusCode, 200);
    const { upload } = res.body;
    assert.equal(upload.cloudName, "unit-test-cloud");
    assert.equal(upload.apiKey, "unit-test-key");
    assert.equal(upload.fields.type, "authenticated");
    assert.match(upload.fields.transformation, /w_1600/);
    assert.match(upload.fields.transformation, /f_webp/);
    assert.match(upload.fields.allowed_formats, /heic/);
    assert.equal(upload.fields.upload_preset, undefined);
    assert.equal(upload.fields.file, undefined);
    assert.equal(JSON.stringify(upload).includes(SECRET), false);
    assert.equal(
      signatureMatches(
        {
          allowed_formats: upload.fields.allowed_formats,
          public_id: upload.fields.public_id,
          timestamp: upload.fields.timestamp,
          transformation: upload.fields.transformation,
          type: upload.fields.type,
        },
        upload.fields.signature,
        SECRET
      ),
      true
    );
    assert.match(upload.fields.public_id, /^c\/4\/items\/10\/[a-f0-9]{32}$/);
  });

  it("saves the stored photo, ignores a remote URL, and leaves the rest of the item alone", async () => {
    resetItemPhotosForTests();
    const calls = installStorage(goodResource());
    const queries = installDb({ item: { id: 10, image_public_id: "c/4/items/10/" + "a".repeat(32) } });
    const started = mockRes();
    await createItemPhotoUpload(req(), started);
    const publicId = started.body.upload.fields.public_id;

    const res = mockRes();
    await saveItemPhoto(
      req({ publicId, url: "https://evil.example/secret.jpg" }),
      res
    );
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.photo.url, `https://signed.example/${publicId}`);
    assert.equal(res.body.photo.format, "webp");
    assert.equal(res.body.photo.bytes, 180000);
    assert.equal(res.body.image_public_id, undefined);
    assert.equal(JSON.stringify(res.body).includes(SECRET), false);
    assert.deepEqual(calls.fetched, [publicId]);
    assert.equal(calls.fetched.includes("https://evil.example/secret.jpg"), false);
    const update = queries.find((query) => query.sql.includes("UPDATE items"));
    assert.match(update.sql, /image_public_id = \$1/);
    assert.equal(/name\s*=/.test(update.sql), false);
    assert.equal(/sku\s*=/.test(update.sql), false);
    assert.equal(update.params[5], 10);
    assert.equal(update.params[6], 4);
    assert.equal(calls.destroyed.length, 1);
    assert.notEqual(calls.destroyed[0], publicId);
  });

  it("rejects a photo for another item and an oversized or invalid file", async () => {
    resetItemPhotosForTests();
    const calls = installStorage(goodResource({ bytes: ITEM_PHOTO_MAX_BYTES + 1 }));
    installDb();
    const other = mockRes();
    await saveItemPhoto(req({ publicId: "c/9/items/10/" + "b".repeat(32) }), other);
    assert.equal(other.statusCode, 400);
    assert.equal(other.body.code, "PHOTO_WRONG_ITEM");
    assert.deepEqual(calls.fetched, []);
    assert.deepEqual(calls.destroyed, []);

    const started = mockRes();
    await createItemPhotoUpload(req(), started);
    const publicId = started.body.upload.fields.public_id;
    const tooBig = mockRes();
    await saveItemPhoto(req({ publicId }), tooBig);
    assert.equal(tooBig.statusCode, 400);
    assert.equal(tooBig.body.code, "PHOTO_TOO_LARGE");
    assert.deepEqual(calls.destroyed, [publicId]);

    calls.destroyed.length = 0;
    calls.fetched.length = 0;
    installStorage(goodResource({ format: "heic", resource_type: "image" }));
    const startedAgain = mockRes();
    await createItemPhotoUpload(req(), startedAgain);
    const invalid = mockRes();
    await saveItemPhoto(
      req({ publicId: startedAgain.body.upload.fields.public_id }),
      invalid
    );
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.body.code, "PHOTO_INVALID");
  });

  it("deletes only this company's photo and stops when storage does not confirm", async () => {
    resetItemPhotosForTests();
    const calls = installStorage(goodResource());
    const publicId = "c/4/items/10/" + "c".repeat(32);
    installDb({ item: { id: 10, image_public_id: publicId } });
    const res = mockRes();
    await deleteItemPhoto(req(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.photo, null);
    assert.deepEqual(calls.destroyed, [publicId]);

    installDb({ item: { id: 10, image_public_id: "other/company/photo" } });
    const unsafe = mockRes();
    await deleteItemPhoto(req(), unsafe);
    assert.equal(unsafe.statusCode, 200);
    assert.deepEqual(calls.destroyed, [publicId]);
  });

  it("limits upload starts and refuses photos before the columns exist", async () => {
    resetItemPhotosForTests();
    installStorage(goodResource());
    installDb();
    for (let i = 0; i < ITEM_PHOTO_UPLOADS_PER_WINDOW; i += 1) {
      const res = mockRes();
      await createItemPhotoUpload(req(), res);
      assert.equal(res.statusCode, 200);
    }
    const limited = mockRes();
    await createItemPhotoUpload(req(), limited);
    assert.equal(limited.statusCode, 429);
    assert.equal(limited.body.code, "PHOTO_RATE_LIMITED");

    resetItemPhotosForTests();
    installStorage(goodResource());
    installDb({ columns: false });
    const missing = mockRes();
    await createItemPhotoUpload(req(), missing);
    assert.equal(missing.statusCode, 503);
    assert.equal(missing.body.code, "PHOTO_STORAGE_UNAVAILABLE");
  });

  it("returns a signed photo on the item and does not return the storage id", async () => {
    resetItemPhotosForTests();
    installStorage(goodResource());
    const publicId = "c/4/items/10/" + "d".repeat(32);
    pool.query = async (sql) => {
      if (String(sql).includes("information_schema")) return { rows: [] };
      return {
        rows: [
          {
            id: 10,
            name: "Soap",
            client_id: 4,
            image_public_id: publicId,
            image_width: 1600,
            image_height: 900,
            image_bytes: 180000,
            image_format: "webp",
          },
        ],
      };
    };
    const res = mockRes();
    await getItemById(req(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.image_public_id, undefined);
    assert.equal(res.body.photo.url, `https://signed.example/${publicId}`);
    assert.equal(res.body.photo.width, 1600);
    assert.equal(JSON.stringify(res.body).includes(SECRET), false);
    assert.equal(assessStoredPhoto(goodResource()).ok, true);
  });
});
