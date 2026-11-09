const jwt = require("jsonwebtoken");
const { getSecret } = require("../config/secrets");

const API_VERSION = process.env.SF_API_VERSION || "v60.0";
const TOKEN_TTL_MS = 50 * 60 * 1000; // renovamos antes de que expire la sesión

let tokenCache = null; // { accessToken, instanceUrl, expiresAt }

async function authenticate() {
    const [consumerKey, privateKeyRaw, username, loginUrl, instanceUrlSecret] =
        await Promise.all([
            getSecret("SF_CONSUMER_KEY"),
            getSecret("SF_JWT_PRIVATE_KEY"),
            getSecret("SF_SF_USERNAME"),
            getSecret("SF_LOGIN_URL"),
            getSecret("SF_INSTANCE_URL"),
        ]);

    // Por si la llave quedó guardada con "\n" literales
    const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

    const assertion = jwt.sign(
        {
            iss: consumerKey,
            sub: username,
            aud: loginUrl, // https://login.salesforce.com o https://test.salesforce.com
        },
        privateKey,
        { algorithm: "RS256", expiresIn: 180 }
    );

    const res = await fetch(`${loginUrl}/services/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion,
        }),
    });

    const data = await res.json();
    if (!res.ok) {
        throw new Error(
            `Error autenticando en Salesforce: ${data.error} - ${data.error_description}`
        );
    }

    tokenCache = {
        accessToken: data.access_token,
        instanceUrl: data.instance_url || instanceUrlSecret,
        expiresAt: Date.now() + TOKEN_TTL_MS,
    };
    return tokenCache;
}

async function getAuth() {
    if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache;
    return authenticate();
}

async function sfRequest(path, options = {}, retry = true) {
    const { accessToken, instanceUrl } = await getAuth();

    const res = await fetch(`${instanceUrl}/services/data/${API_VERSION}${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
            ...(options.headers || {}),
        },
    });

    // Token vencido: renovamos y reintentamos una vez
    if (res.status === 401 && retry) {
        tokenCache = null;
        return sfRequest(path, options, false);
    }

    const text = await res.text();
    const data = text ? JSON.parse(text) : null;

    if (!res.ok) {
        const err = new Error("Error en la API de Salesforce");
        err.status = res.status;
        err.details = data;
        throw err;
    }
    return data;
}

// --- Funciones de ejemplo ---
function query(soql) {
    return sfRequest(`/query?q=${encodeURIComponent(soql)}`);
}

function getRecord(sobject, id) {
    return sfRequest(`/sobjects/${sobject}/${id}`);
}

function createRecord(sobject, body) {
    return sfRequest(`/sobjects/${sobject}`, {
        method: "POST",
        body: JSON.stringify(body),
    });
}

function updateRecord(sobject, id, body) {
    return sfRequest(`/sobjects/${sobject}/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
    });
}

const ID_REGEX = /^[a-zA-Z0-9]{15,18}$/;

// Trae los pagos de un plan, del más antiguo al más reciente
async function getPagosByPlan(idPlanPago) {
    if (!ID_REGEX.test(idPlanPago)) throw new Error("idPlanPago inválido");

    const data = await query(
        `SELECT Id, Name, Fecha__c, Tipo__c, Monto__c, Monto_Mantenimiento__c, Monto_Agua__c, Monto_Estacionamiento__c, Monto_Otros__c FROM Pago__c ` +
        `WHERE Plan_de_Pago__c = '${idPlanPago}' ORDER BY Fecha__c ASC`
    );
    return data.records;
}

// Trae los planes de pago cuyo lookup apunta a la oportunidad
async function getPlanesByOpportunity(opportunityId) {
    if (!ID_REGEX.test(opportunityId)) throw new Error("opportunityId inválido");

    const data = await query(
        `SELECT Id, Name, RecordTypeId, Fecha_de_Inicio__c, Fecha_fin_de_contrato__c ` +
        `FROM Plan_de_Pago__c ` +
        `WHERE Oportunidad__c = '${opportunityId}' ` + // <-- confirma el API name del lookup
        `ORDER BY CreatedDate DESC`
    );
    return data.records;
}

// Crea varios registros en una sola llamada (todo o nada, máx. 200 por llamada)
async function createRecords(sobject, records) {
    const created = [];

    for (let i = 0; i < records.length; i += 200) {
        const chunk = records.slice(i, i + 200).map((r) => ({
            attributes: { type: sobject },
            ...r,
        }));

        const results = await sfRequest("/composite/sobjects", {
            method: "POST",
            body: JSON.stringify({ allOrNone: true, records: chunk }),
        });

        const failed = results.filter((r) => !r.success);
        if (failed.length) {
            const err = new Error("Error creando registros en Salesforce");
            err.status = 400;
            err.details = failed;
            throw err;
        }
        created.push(...results);
    }
    return created;
}

module.exports = {
    query,
    getRecord,
    createRecord,
    updateRecord,
    getPagosByPlan,
    getPlanesByOpportunity,
    createRecords,
};