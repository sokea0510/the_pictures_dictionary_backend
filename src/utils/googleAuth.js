const fs = require("fs");
const path = require("path");
const { GoogleAuth } = require("google-auth-library");

const DEFAULT_SA_FILE = "gen-lang-client-0216008081-e6aa74f41268.json";

const cache = {
  auth: null,
  keyFile: "",
  projectId: "",
};

const resolveServiceAccountFile = () => {
  const explicit = String(process.env.GOOGLE_SERVICE_ACCOUNT_FILE || "").trim();
  if (explicit && fs.existsSync(explicit)) return explicit;
  const local = path.resolve(process.cwd(), DEFAULT_SA_FILE);
  if (fs.existsSync(local)) return local;
  return "";
};

const getAuth = () => {
  const keyFile = resolveServiceAccountFile();
  if (!keyFile) return null;
  if (!cache.auth || cache.keyFile !== keyFile) {
    cache.auth = new GoogleAuth({ keyFile });
    cache.keyFile = keyFile;
    cache.projectId = "";
  }
  return cache.auth;
};

const hasGoogleServiceAccount = () => !!resolveServiceAccountFile();

const getGoogleProjectId = async () => {
  const auth = getAuth();
  if (!auth) return "";
  if (cache.projectId) return cache.projectId;
  const projectId = await auth.getProjectId().catch(() => "");
  cache.projectId = String(projectId || "");
  return cache.projectId;
};

const getGoogleAccessToken = async (scopes = ["https://www.googleapis.com/auth/cloud-platform"]) => {
  const auth = getAuth();
  if (!auth) return "";
  const client = await auth.getClient({ scopes });
  const token = await client.getAccessToken();
  return String((token && token.token) || token || "");
};

module.exports = {
  hasGoogleServiceAccount,
  getGoogleAccessToken,
  getGoogleProjectId,
};

