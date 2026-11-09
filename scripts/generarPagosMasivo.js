#!/usr/bin/env node
/**
 * Script CLI interactivo para generar pagos de alquiler masivamente.
 *
 * Uso:  node scripts/generarPagosMasivo.js
 *
 * Flujo:
 *  1. Te pide IDs de asset uno por uno (escribe "listo" o deja vacío para terminar).
 *  2. Ejecuta dry run para cada asset y muestra el resumen.
 *  3. Te pregunta si confirmas la creación real.
 *  4. Crea los pagos en Salesforce.
 */
require("dotenv").config();

const readline = require("readline");
const { procesarAsset } = require("../src/logic/generarPagos");

// ─── Helpers ───────────────────────────────────────────────────────────

function crearRL() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
}

function preguntar(rl, texto) {
    return new Promise((resolve) => rl.question(texto, resolve));
}

function separador(titulo) {
    console.log("\n" + "═".repeat(70));
    if (titulo) console.log(`  ${titulo}`);
    console.log("═".repeat(70));
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main() {
    const rl = crearRL();

    separador("GENERACIÓN MASIVA DE PAGOS DE ALQUILER");
    console.log("  Ingresa los IDs de los assets que deseas procesar.");
    console.log('  Cuando termines, escribe "listo" o presiona Enter sin texto.\n');

    // 1. Recolectar IDs
    const assetIds = [];
    let contador = 1;

    while (true) {
        const input = (await preguntar(rl, `  Asset #${contador}: `)).trim();

        if (!input || input.toLowerCase() === "listo") {
            break;
        }

        if (!/^[a-zA-Z0-9]{15,18}$/.test(input)) {
            console.log('  ⚠  ID inválido (debe ser 15 o 18 caracteres alfanuméricos). Intenta de nuevo.');
            continue;
        }

        if (assetIds.includes(input)) {
            console.log("  ⚠  Ese ID ya está en la lista. Intenta con otro.");
            continue;
        }

        assetIds.push(input);
        contador++;
    }

    if (!assetIds.length) {
        console.log("\n  No se ingresó ningún asset. Saliendo...\n");
        rl.close();
        process.exit(0);
    }

    separador(`DRY RUN — ${assetIds.length} asset(s)`);
    console.log("  Procesando cada asset en modo simulación...\n");

    // 2. Dry run de todos
    const resultados = [];

    for (let idx = 0; idx < assetIds.length; idx++) {
        const id = assetIds[idx];
        separador(`[${idx + 1}/${assetIds.length}] Asset: ${id}`);

        try {
            const resultado = await procesarAsset(id, /* dryRun */ true);
            resultados.push({ id, ok: true, resultado });
        } catch (err) {
            console.log(`  ❌ ERROR: ${err.message}`);
            resultados.push({ id, ok: false, error: err.message });
        }
    }

    // 3. Resumen
    separador("RESUMEN DEL DRY RUN");

    const exitosos = resultados.filter((r) => r.ok);
    const fallidos = resultados.filter((r) => !r.ok);
    const totalPagos = exitosos.reduce((sum, r) => sum + r.resultado.porCrear.length, 0);

    console.log(`\n  ✅ Exitosos: ${exitosos.length}/${resultados.length}`);
    if (fallidos.length) {
        console.log(`  ❌ Con error: ${fallidos.length}`);
        fallidos.forEach((f) => console.log(`     - ${f.id}: ${f.error}`));
    }

    console.log(`\n  Total de pagos por crear: ${totalPagos}\n`);

    if (exitosos.length) {
        console.log("  Detalle por asset:");
        console.table(
            exitosos.map((r) => ({
                Asset: r.id,
                Nombre: r.resultado.assetName,
                Oportunidad: r.resultado.opportunityName,
                Existentes: r.resultado.existentes,
                PorCrear: r.resultado.porCrear.length,
                PrimeraFecha: r.resultado.porCrear[0]?.Fecha__c || "—",
                ÚltimaFecha: r.resultado.porCrear[r.resultado.porCrear.length - 1]?.Fecha__c || "—",
                Monto: r.resultado.montoAlquiler,
                Mantenimiento: r.resultado.montoMantenimiento,
            }))
        );
    }

    if (!totalPagos) {
        console.log("  No hay pagos por crear en ningún asset. Saliendo...\n");
        rl.close();
        process.exit(0);
    }

    // 4. Confirmación
    const respuesta = await preguntar(
        rl,
        `\n  ¿Deseas CREAR los ${totalPagos} pagos en Salesforce? (si/no): `
    );

    if (respuesta.trim().toLowerCase() !== "si") {
        console.log("\n  Operación cancelada. No se creó nada.\n");
        rl.close();
        process.exit(0);
    }

    // 5. Creación real
    separador(`CREANDO ${totalPagos} PAGOS EN SALESFORCE`);

    let totalCreados = 0;
    let totalErrores = 0;

    for (let idx = 0; idx < exitosos.length; idx++) {
        const { id } = exitosos[idx];
        separador(`[${idx + 1}/${exitosos.length}] Creando pagos para Asset: ${id}`);

        try {
            const resultado = await procesarAsset(id, /* dryRun */ false);
            totalCreados += resultado.creados;
            console.log(`  ✅ ${resultado.creados} pagos creados`);
        } catch (err) {
            totalErrores++;
            console.log(`  ❌ ERROR al crear: ${err.message}`);
            if (err.details) console.log("     Detalles:", JSON.stringify(err.details, null, 2));
        }
    }

    // 6. Resumen final
    separador("RESULTADO FINAL");
    console.log(`\n  ✅ Pagos creados: ${totalCreados}`);
    if (totalErrores) console.log(`  ❌ Assets con error: ${totalErrores}`);
    console.log("");

    rl.close();
    process.exit(0);
}

main().catch((err) => {
    console.error("\n  Error fatal:", err);
    process.exit(1);
});
