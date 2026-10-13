const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { unzipSync, zipSync } = require("fflate");

const API = "https://minecraft.curseforge.com/api";
const MODRINTH_API = "https://api.modrinth.com/v2";
const USER_AGENT =
  "Polyfrost/DataStorageV2 (github.com/Polyfrost/DataStorageV2) curseforge-publisher";

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes("--dry-run");
const GENERATED_DIR =
  ARGS.find((arg) => !arg.startsWith("--")) ||
  path.join(__dirname, ".cache", "curseforge");

const TOKEN = process.env.CURSEFORGE_TOKEN;
const PROJECT_ID = process.env.CURSEFORGE_MODPACK_PROJECT_ID;
const PACK_VERSION = process.env.CURSEFORGE_PACK_VERSION;
const MODRINTH_PROJECT_ID = process.env.MODRINTH_MODPACK_PROJECT_ID;
const COMMIT = process.env.GITHUB_SHA;

const STATE_FILE = path.join(
  __dirname,
  "..",
  "data",
  "oneclient",
  "bundles",
  ".curseforge-published.json"
);

const LOADER = "fabric";
const PREFIX = "oneclient-";
const DISPLAY_NAME = "OneClient";
const MANIFEST_NAME = "manifest.json";
const ZIP_MTIME = new Date(1980, 0, 1);

const CONTENT_MARKER = (digest) => `Content SHA-1: \`${digest}\``;

const IGNORED_MC = new Set(["1.8.9-ornithe"]);

function sha1(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex");
}

function readState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

async function api(pathname, options = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...options,
    headers: {
      "X-Api-Token": TOKEN,
      "User-Agent": USER_AGENT,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `CurseForge API ${options.method || "GET"} ${pathname} -> ${res.status} ${res.statusText}\n${body}`
    );
  }
  return res;
}

async function gameVersionIds() {
  const types = await (await api("/game/version-types")).json();
  const minecraftTypes = new Set(
    types.filter((t) => t.slug.startsWith("minecraft-")).map((t) => t.id)
  );
  const versions = await (await api("/game/versions")).json();
  const ids = new Map();
  for (const version of versions) {
    if (minecraftTypes.has(version.gameVersionTypeID)) {
      ids.set(version.name, version.id);
    }
  }
  return ids;
}

async function modrinthVersionNumbers() {
  const numbers = new Map();
  if (!MODRINTH_PROJECT_ID) return numbers;
  const res = await fetch(
    `${MODRINTH_API}/project/${MODRINTH_PROJECT_ID}/version`,
    { headers: { "User-Agent": USER_AGENT } }
  );
  if (!res.ok) {
    throw new Error(
      `Modrinth API GET /project/${MODRINTH_PROJECT_ID}/version -> ${res.status} ${res.statusText}`
    );
  }
  const versions = (await res.json()).sort(
    (a, b) => new Date(b.date_published) - new Date(a.date_published)
  );
  for (const version of versions) {
    for (const mc of version.game_versions) {
      if (!numbers.has(mc)) numbers.set(mc, version.version_number);
    }
  }
  return numbers;
}

function withVersion(buffer, version) {
  const entries = unzipSync(new Uint8Array(buffer));
  if (!entries[MANIFEST_NAME]) {
    throw new Error(`${MANIFEST_NAME} not found in pack`);
  }
  const manifest = JSON.parse(
    Buffer.from(entries[MANIFEST_NAME]).toString("utf8")
  );
  manifest.version = version;
  entries[MANIFEST_NAME] = new Uint8Array(
    Buffer.from(JSON.stringify(manifest, null, 2))
  );
  const stamped = {};
  for (const [name, data] of Object.entries(entries)) {
    stamped[name] = [data, { mtime: ZIP_MTIME }];
  }
  return { buffer: Buffer.from(zipSync(stamped)), files: manifest.files.length };
}

async function upload({ mc, gameVersionId, file, version, contentSha1 }) {
  const metadata = {
    changelog: `Automated build for Minecraft ${mc}.${
      COMMIT ? ` (${COMMIT.slice(0, 7)})` : ""
    }\n\n${CONTENT_MARKER(contentSha1)}`,
    changelogType: "markdown",
    displayName: `${DISPLAY_NAME} ${version} (${mc})`,
    gameVersions: [gameVersionId],
    releaseType: "release",
  };

  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  form.append(
    "file",
    new Blob([file.buffer], { type: "application/zip" }),
    file.name
  );

  const res = await api(`/projects/${PROJECT_ID}/upload-file`, {
    method: "POST",
    body: form,
  });
  const { id } = await res.json();
  console.log(`  published ${DISPLAY_NAME} ${mc} (${version}) as file ${id}`);
  return id;
}

async function main() {
  if (!TOKEN) {
    console.log("CURSEFORGE_TOKEN not set; skipping CurseForge publish.");
    return;
  }
  if (!PROJECT_ID) {
    console.log(
      "CURSEFORGE_MODPACK_PROJECT_ID not set; skipping CurseForge publish."
    );
    return;
  }
  if (!fs.existsSync(GENERATED_DIR)) {
    console.log(`No generated dir at ${GENERATED_DIR}; nothing to publish.`);
    return;
  }

  const suffix = `-${LOADER}.zip`;
  const packs = fs
    .readdirSync(GENERATED_DIR)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(suffix))
    .sort()
    .map((filename) => ({
      filename,
      mc: filename.slice(PREFIX.length, -suffix.length),
    }))
    .filter(({ mc }) => !IGNORED_MC.has(`${mc}-${LOADER}`));

  if (packs.length === 0) {
    console.log("No generated CurseForge packs; nothing to publish.");
    return;
  }

  const gameVersions = await gameVersionIds();
  const modrinthNumbers = PACK_VERSION ? new Map() : await modrinthVersionNumbers();

  const state = readState();
  const uploads = [];
  for (const { filename, mc } of packs) {
    const buffer = fs.readFileSync(path.join(GENERATED_DIR, filename));
    const contentSha1 = sha1(buffer);
    if (state[mc]?.[contentSha1]) {
      uploads.push({ mc, filename, upToDate: true });
      continue;
    }

    const gameVersionId = gameVersions.get(mc);
    if (!gameVersionId) {
      throw new Error(`CurseForge has no Minecraft game version named ${mc}`);
    }
    const version = PACK_VERSION || modrinthNumbers.get(mc);
    if (!version) {
      throw new Error(
        `No version for ${mc}: set CURSEFORGE_PACK_VERSION or MODRINTH_MODPACK_PROJECT_ID`
      );
    }

    const stamped = withVersion(buffer, version);
    uploads.push({
      mc,
      gameVersionId,
      version,
      contentSha1,
      files: stamped.files,
      file: {
        buffer: stamped.buffer,
        name: `${DISPLAY_NAME}-${mc}-${LOADER}-${version}.zip`,
      },
    });
  }

  console.log(`Project ${DISPLAY_NAME} (${PROJECT_ID}):`);
  for (const entry of uploads) {
    if (entry.upToDate) {
      console.log(`  up to date: ${entry.mc} (${entry.filename})`);
      continue;
    }
    if (DRY_RUN) {
      console.log(
        `  dry run: ${entry.file.name} (${entry.files} files, game version ${entry.gameVersionId}, content ${entry.contentSha1})`
      );
      continue;
    }
    const fileID = await upload(entry);
    state[entry.mc] = {
      ...(state[entry.mc] || {}),
      [entry.contentSha1]: { version: entry.version, fileID },
    };
    writeState(state);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
