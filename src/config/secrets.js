const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");

const client = new SecretManagerServiceClient();
const cache = new Map();

async function getSecret(name) {
    if (cache.has(name)) return cache.get(name);

    const projectId = process.env.GCP_PROJECT_ID;
    if (!projectId) throw new Error("Falta GCP_PROJECT_ID en el .env");

    const [version] = await client.accessSecretVersion({
        name: `projects/${projectId}/secrets/${name}/versions/latest`,
    });

    const value = version.payload.data.toString("utf8").trim();
    cache.set(name, value);
    return value;
}

module.exports = { getSecret };