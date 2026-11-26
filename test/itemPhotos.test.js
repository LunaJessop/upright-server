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
  ITEM_PHOTO_THUMB_EDGE,
  ITEM_PHOTO_MAX_INCOMING_BYTES,
  ITEM_PHOTO_UPLOADS_PER_WINDOW,
  ifNoneMatchSatisfied,
  itemPhotoEtag,
  itemPhotoVersion,
  presentItemPhoto,
  resetItemPhotosForTests,
  setPhotoStorageForTests,
  sniffPhoto,
} = await import("../lib/itemPhotos.js");
const { deleteItemPhoto, getItemPhoto, getItemPhotoThumb, uploadItemPhoto } = await import(
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

function installStorage(downloadBytes) {
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
      return downloadBytes ?? Buffer.from("webp-bytes");
    },
  });
  return calls;
}

function installDb({
  item = { id: 10, image_public_id: null },
  columns = true,
  failUpdate = false,
  enforceOwner = false,
} = {}) {
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
    if (text.includes("FROM items")) {
      if (enforceOwner && params[1] !== 4) return { rows: [] };
      return { rows: item ? [item] : [] };
    }
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
    assert.match(res.body.photo.version, /^[a-f0-9]{64}$/);
    assert.equal(res.body.photo.version, itemPhotoVersion(calls.uploads[0].publicId));
    assert.equal(JSON.stringify(res.body).includes(calls.uploads[0].publicId), false);
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
    assert.equal(res.headers["etag"], undefined);
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
    assert.equal(item.body.photo.version, itemPhotoVersion(publicId));
    assert.equal(JSON.stringify(item.body).includes(publicId), false);
    assert.equal(JSON.stringify(item.body).includes(SECRET), false);
  });

  it("returns 404 for a thumbnail the company does not own or that has no photo", async () => {
    resetItemPhotosForTests();
    const calls = installStorage();
    const publicId = "c/4/items/10/" + "e".repeat(32);
    const queries = installDb({
      item: { id: 10, image_public_id: publicId, image_format: "webp" },
      enforceOwner: true,
    });

    const otherCompany = mockRes();
    await getItemPhotoThumb(
      { auth: { clientId: 9, userId: 3 }, params: { id: "10" }, headers: {} },
      otherCompany
    );
    assert.equal(otherCompany.statusCode, 404);
    assert.equal(otherCompany.body.error, "This item has no photo.");
    assert.deepEqual(calls.downloads, []);

    const ownedRead = queries.find((query) => query.sql.includes("FROM items"));
    assert.match(ownedRead.sql, /client_id/);
    assert.deepEqual(ownedRead.params, [10, 9]);

    resetItemPhotosForTests();
    const wrongId = installStorage();
    installDb({
      item: { id: 10, image_public_id: "c/9/items/10/" + "f".repeat(32), image_format: "webp" },
    });
    const mismatched = mockRes();
    await getItemPhotoThumb(
      { auth: { clientId: 4, userId: 9 }, params: { id: "10" }, headers: {} },
      mismatched
    );
    assert.equal(mismatched.statusCode, 404);
    assert.deepEqual(wrongId.downloads, []);

    resetItemPhotosForTests();
    const bare = installStorage();
    installDb({ item: { id: 10, image_public_id: null } });
    const missing = mockRes();
    await getItemPhotoThumb(
      { auth: { clientId: 4, userId: 9 }, params: { id: "10" }, headers: {} },
      missing
    );
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.body.error, "This item has no photo.");
    assert.deepEqual(bare.downloads, []);

    const invalid = mockRes();
    await getItemPhotoThumb(
      { auth: { clientId: 4, userId: 9 }, params: { id: "nope" }, headers: {} },
      invalid
    );
    assert.equal(invalid.statusCode, 400);
  });

  it("serves a small cached thumbnail and a new version after the photo is replaced", async () => {
    resetItemPhotosForTests();
    const original = await sharp({
      create: {
        width: 180,
        height: 60,
        channels: 3,
        background: { r: 10, g: 120, b: 200 },
      },
    })
      .webp()
      .toBuffer();
    const calls = installStorage(original);
    const firstId = "c/4/items/10/" + "a".repeat(32);
    const secondId = "c/4/items/10/" + "b".repeat(32);
    const item = { id: 10, image_public_id: firstId, image_format: "jpeg" };
    installDb({ item });

    const full = mockRes();
    await getItemPhoto(
      { auth: { clientId: 4, userId: 9 }, params: { id: "10" }, headers: {} },
      full
    );
    assert.equal(full.headers["cache-control"], "private, no-store");
    assert.equal(full.headers["etag"], undefined);
    assert.equal(Buffer.compare(full.ended, original), 0);

    const thumb = mockRes();
    await getItemPhotoThumb(
      { auth: { clientId: 4, userId: 9 }, params: { id: "10" }, headers: {} },
      thumb
    );
    assert.equal(thumb.statusCode, 200);
    assert.equal(thumb.headers["content-type"], "image/webp");
    assert.equal(thumb.headers["cache-control"], "private, max-age=300");
    assert.equal(thumb.headers["vary"], "Authorization");
    assert.equal(thumb.headers["x-content-type-options"], "nosniff");
    assert.equal(thumb.headers["etag"], itemPhotoEtag(firstId));
    assert.equal(thumb.headers["etag"].includes(firstId), false);
    const meta = await sharp(thumb.ended).metadata();
    assert.equal(meta.width, ITEM_PHOTO_THUMB_EDGE);
    assert.equal(meta.height, ITEM_PHOTO_THUMB_EDGE);
    assert.equal(meta.format, "webp");
    assert.notEqual(Buffer.compare(thumb.ended, original), 0);
    assert.equal(thumb.ended.includes(Buffer.from(firstId)), false);
    assert.equal(JSON.stringify(thumb.headers).includes("res.cloudinary.com"), false);
    assert.equal(JSON.stringify(thumb.headers).includes(SECRET), false);
    assert.deepEqual(calls.downloads, [firstId, firstId]);

    const fresh = mockRes();
    await getItemPhotoThumb(
      {
        auth: { clientId: 4, userId: 9 },
        params: { id: "10" },
        headers: { "if-none-match": '"not-the-etag"' },
      },
      fresh
    );
    assert.equal(fresh.statusCode, 200);
    assert.equal(calls.downloads.length, 3);

    const cached = mockRes();
    await getItemPhotoThumb(
      {
        auth: { clientId: 4, userId: 9 },
        params: { id: "10" },
        headers: { "if-none-match": `W/${thumb.headers.etag}, "other"` },
      },
      cached
    );
    assert.equal(cached.statusCode, 304);
    assert.equal(cached.headers["cache-control"], "private, max-age=300");
    assert.equal(cached.headers["vary"], "Authorization");
    assert.equal(cached.headers["etag"], thumb.headers.etag);
    assert.equal(cached.ended, undefined);
    assert.equal(calls.downloads.length, 3);
    assert.equal(ifNoneMatchSatisfied("*", thumb.headers.etag), true);

    const firstVersion = presentItemPhoto({
      image_public_id: firstId,
      image_width: 180,
      image_height: 60,
      image_bytes: original.length,
      image_format: "webp",
    }).photo.version;
    item.image_public_id = secondId;
    const replaced = mockRes();
    await getItemPhotoThumb(
      { auth: { clientId: 4, userId: 9 }, params: { id: "10" }, headers: {} },
      replaced
    );
    const secondVersion = presentItemPhoto({
      image_public_id: secondId,
      image_width: 180,
      image_height: 60,
      image_bytes: original.length,
      image_format: "webp",
    }).photo.version;
    assert.match(firstVersion, /^[a-f0-9]{64}$/);
    assert.notEqual(firstVersion, secondVersion);
    assert.equal(firstVersion.includes(firstId), false);
    assert.equal(replaced.headers["etag"], itemPhotoEtag(secondId));
    assert.notEqual(replaced.headers["etag"], thumb.headers.etag);
    assert.equal(calls.downloads.at(-1), secondId);
    assert.equal(JSON.stringify(replaced.headers).includes(secondId), false);
    assert.equal(presentItemPhoto({ image_public_id: null }).photo, null);
  });

  it("does not cache a thumbnail it could not build", async () => {
    resetItemPhotosForTests();
    const publicId = "c/4/items/10/" + "d".repeat(32);
    installStorage(Buffer.from("not-a-photo"));
    installDb({
      item: { id: 10, image_public_id: publicId, image_format: "webp" },
    });
    const res = mockRes();
    await getItemPhotoThumb(
      { auth: { clientId: 4, userId: 9 }, params: { id: "10" }, headers: {} },
      res
    );
    assert.equal(res.statusCode, 502);
    assert.equal(res.headers["cache-control"], undefined);
    assert.equal(res.ended, undefined);
    assert.equal(JSON.stringify(res.body).includes(publicId), false);
    assert.equal(JSON.stringify(res.body).includes("res.cloudinary.com"), false);
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
