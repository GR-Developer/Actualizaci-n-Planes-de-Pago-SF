const { Router } = require("express");
const sf = require("../services/salesforce");
const { procesarAsset } = require("../logic/generarPagos");
const router = Router();

// Prueba de conexión: GET /api/salesforce/ping
router.get("/ping", async (req, res, next) => {
    try {
        const data = await sf.query("SELECT Id, Name FROM Contact LIMIT 1");
        res.json({ ok: true, totalSize: data.totalSize });
    } catch (err) {
        next(err);
    }
});

// GET /api/salesforce/contact/:id
router.get("/contact/:id", async (req, res, next) => {
    try {
        const { id } = req.params;
        if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) {
            return res.status(400).json({ error: "Id inválido" });
        }
        const contact = await sf.getRecord("Contact", id);
        res.json(contact);
    } catch (err) {
        next(err);
    }
});



// ─── ENDPOINT INDIVIDUAL ───────────────────────────────────────────────
// POST /api/salesforce/asset/:idAsset/generarPagos?dryRun=true
router.post("/asset/:idAsset/generarPagos", async (req, res, next) => {
    try {
        const { idAsset } = req.params;
        const dryRun = req.query.dryRun === "true";

        const resultado = await procesarAsset(idAsset, dryRun);
        res.status(200).json(resultado);
    } catch (error) {
        console.log("ERROR:", error.message, error.details || "");
        if (error.code === "INVALID_ID") return res.status(400).json({ error: error.message });
        if (error.code) return res.status(422).json({ error: error.message, code: error.code });
        next(error);
    }
});


// ─── ENDPOINT MASIVO ───────────────────────────────────────────────────
// POST /api/salesforce/assets/generarPagos
// Body: { "assetIds": ["id1", "id2", ...], "dryRun": true }
//
// Procesa cada asset secuencialmente y devuelve un resumen global.
// Por defecto dryRun es true (simulación). Para crear de verdad: "dryRun": false
router.post("/assets/generarPagos", async (req, res, next) => {
    try {
        const { assetIds, dryRun: dryRunBody } = req.body || {};
        const dryRun = dryRunBody !== false; // por defecto es dry run (seguro)

        // Validar que venga un array
        if (!Array.isArray(assetIds) || !assetIds.length) {
            return res.status(400).json({
                error: 'Se requiere un array "assetIds" con al menos un ID.',
                ejemplo: { assetIds: ["02iXXXXXXXXXXXXXXX"], dryRun: true },
            });
        }

        console.log("═".repeat(70));
        console.log(`  GENERACIÓN MASIVA — ${assetIds.length} asset(s) — dryRun: ${dryRun}`);
        console.log("═".repeat(70));

        const resultados = [];

        for (let idx = 0; idx < assetIds.length; idx++) {
            const id = assetIds[idx];
            console.log(`\n${"─".repeat(60)}`);
            console.log(`  [${idx + 1}/${assetIds.length}] Asset: ${id}`);
            console.log("─".repeat(60));

            try {
                const resultado = await procesarAsset(id, dryRun);

                resultados.push({
                    idAsset: id,
                    ok: true,
                    assetName: resultado.assetName,
                    opportunityName: resultado.opportunityName,
                    existentes: resultado.existentes,
                    creados: resultado.creados,
                    porCrear: resultado.porCrear.length,
                    primeraFecha: resultado.porCrear[0]?.Fecha__c || null,
                    ultimaFecha: resultado.porCrear[resultado.porCrear.length - 1]?.Fecha__c || null,
                    montoAlquiler: resultado.montoAlquiler,
                    montoMantenimiento: resultado.montoMantenimiento,
                    detalle: resultado.porCrear,
                });
            } catch (err) {
                console.log(`  ❌ ERROR: ${err.message}`);
                resultados.push({
                    idAsset: id,
                    ok: false,
                    error: err.message,
                    code: err.code || null,
                });
            }
        }

        // Resumen
        const exitosos = resultados.filter((r) => r.ok);
        const fallidos = resultados.filter((r) => !r.ok);
        const totalPagos = exitosos.reduce((sum, r) => sum + r.porCrear, 0);
        const totalCreados = exitosos.reduce((sum, r) => sum + r.creados, 0);

        console.log("\n" + "═".repeat(70));
        console.log("  RESUMEN FINAL");
        console.log("═".repeat(70));
        console.log(`  Assets procesados: ${resultados.length}`);
        console.log(`  ✅ Exitosos: ${exitosos.length}`);
        if (fallidos.length) console.log(`  ❌ Con error: ${fallidos.length}`);
        console.log(`  Pagos ${dryRun ? "por crear" : "creados"}: ${dryRun ? totalPagos : totalCreados}`);

        if (exitosos.length) {
            console.log("\n  ── EXITOSOS ──");
            console.table(
                exitosos.map((r) => ({
                    Asset: r.idAsset,
                    Nombre: r.assetName,
                    Oportunidad: r.opportunityName,
                    Existentes: r.existentes,
                    [dryRun ? "PorCrear" : "Creados"]: dryRun ? r.porCrear : r.creados,
                    PrimeraFecha: r.primeraFecha || "—",
                    ÚltimaFecha: r.ultimaFecha || "—",
                    Monto: r.montoAlquiler,
                    Mantenimiento: r.montoMantenimiento,
                }))
            );
        }

        if (fallidos.length) {
            console.log("\n  ── FALLIDOS ──");
            console.table(
                fallidos.map((r) => ({
                    Asset: r.idAsset,
                    Error: r.error,
                    Código: r.code || "—",
                }))
            );
        }

        console.log("═".repeat(70) + "\n");

        res.status(200).json({
            dryRun,
            totalAssets: resultados.length,
            exitosos: exitosos.length,
            fallidos: fallidos.length,
            totalPagos: dryRun ? totalPagos : totalCreados,
            resultados,
        });
    } catch (error) {
        console.log("ERROR MASIVO:", error.message, error.details || "");
        next(error);
    }
});

module.exports = router;