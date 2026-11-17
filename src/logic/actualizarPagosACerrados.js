const sf = require("../services/salesforce");

const RT_PLAN_ALQUILER = "0126g000001P0eQAAS";

const { parseFecha, formatFecha } = require("../utils/fechas");

const CAMPO_FECHA_COBRO_ABONO = "Fecha_de_abono__c";
const ESTADO_PAGO_CERRADO = "Cerrado";

const CAMPO_MONTO_ABONO = "Monto_abonado__c";

const NOMBRE_ALQUILER_REGEX = /^ALQUILER\s*#?\s*(\d+)\s*$/i;
const numeroDePago = (name) => {
    const m = NOMBRE_ALQUILER_REGEX.exec((name || "").trim());
    return m ? parseInt(m[1], 10) : null;
};
// const CAMPOS_MONTO_PAGO = [
//     "Monto__c",
//     "Monto_Mantenimiento__c",
//     "Monto_Agua__c",
//     "Monto_Estacionamiento__c",
//     "Monto_Otros__c",
// ];

const esCerrado = (p) =>
    (p.Estado__c || "").toLowerCase() === ESTADO_PAGO_CERRADO.toLowerCase();

// const totalDelPago = (p) =>
//     Math.round(
//         CAMPOS_MONTO_PAGO.reduce(
//             (sum, c) => sum + (Number(p[c]) || 0),
//             0
//         ) * 100
//     ) / 100;


async function obtenerPlanAlquilerDeAsset(idAsset) {
    if (!/^[a-zA-Z0-9]{15,18}$/.test(idAsset)) {
        throw Object.assign(new Error("idAsset inválido"), { code: "INVALID_ID" });
    }

    const asset = await sf.getRecord("Asset", idAsset);
    const opportunityId = asset.Oportunidad__c;
    console.log("1. ASSET", { Id: asset.Id, Name: asset.Name, Oportunidad__c: opportunityId });
    if (!opportunityId) {
        throw Object.assign(new Error("El asset no tiene oportunidad asociada"), { code: "NO_OPPORTUNITY" });
    }

    const opportunityData = await sf.getRecord("Opportunity", opportunityId);
    console.log("2. OPORTUNIDAD", { Id: opportunityData.Id, Name: opportunityData.Name });

    const planes = await sf.getPlanesByOpportunity(opportunityId);
    console.log(`3. PLANES DE LA OPORTUNIDAD: ${planes.length}`);
    if (!planes.length) {
        throw Object.assign(new Error("La oportunidad no tiene plan de pago"), { code: "NO_PLAN" });
    }
    const planesAlquiler = planes.filter((p) => p.RecordTypeId === RT_PLAN_ALQUILER);
    if (!planesAlquiler.length) {
        throw Object.assign(new Error("La oportunidad no tiene un plan de tipo alquiler"), { code: "NO_PLAN_ALQUILER" });
    }
    if (planesAlquiler.length > 1) {
        throw Object.assign(new Error("La oportunidad tiene más de un plan de alquiler"), { code: "MULTIPLES_PLANES" });
    }

    console.log("   PLAN ELEGIDO", { planId: planesAlquiler[0].Id });
    return { asset, opportunityData, planId: planesAlquiler[0].Id };
}


async function procesarCierreAsset(idAsset, dryRun = true) {
    console.log("=== INICIO CIERRE ===", { idAsset, dryRun });

    const { asset, opportunityData, planId } = await obtenerPlanAlquilerDeAsset(idAsset);

    // 4. Pagos de alquiler del plan, del más antiguo al más nuevo
    const todos = await sf.getPagosCompletosByPlan(planId);
    const pagos = todos
        .filter((p) => p.Fecha__c && (p.Tipo__c || "").toLowerCase() === "alquiler")
        .sort(
            (a, b) =>
                a.Fecha__c.localeCompare(b.Fecha__c) ||
                (numeroDePago(a.Name) ?? 0) - (numeroDePago(b.Name) ?? 0)
        );
    console.log(`4. PAGOS DE ALQUILER: ${pagos.length} (de ${todos.length} del plan)`);
    console.table(
        pagos.map((p) => ({
            Id: p.Id,
            Name: p.Name,
            Fecha__c: p.Fecha__c,
            Estado__c: p.Estado__c,
        }))
    );
    console.log(
        "   Campos del pago con 'total' en el nombre:",
        Object.keys(pagos[0] || {}).filter((k) => /total/i.test(k))
    );

    // 5. Último pago cerrado (el más reciente): se cierran todos los pendientes anteriores a ese
    const idxUltimoCerrado = pagos.map(esCerrado).lastIndexOf(true);
    if (idxUltimoCerrado === -1) {
        console.log("   ⚠ Ningún pago cerrado: no se hace nada con este asset");
        throw Object.assign(new Error("El asset no tiene ningún pago cerrado"), { code: "NO_PAGO_CERRADO" });
    }
    const pagoCerrado = pagos[idxUltimoCerrado]; // su abono es la plantilla
    // Solo los que NO están cerrados (los cerrados anteriores no se vuelven a tocar)
    const porCerrar = pagos.slice(0, idxUltimoCerrado).filter((p) => !esCerrado(p));
    console.log("5. LÍMITE", {
        pagoCerrado: { Id: pagoCerrado.Id, Name: pagoCerrado.Name, Fecha__c: pagoCerrado.Fecha__c },
        porCerrar: porCerrar.map((p) => p.Name),
        posterioresSinTocar: pagos.slice(idxUltimoCerrado + 1).map((p) => p.Name),
    });

    const armarResultado = (extra) => ({
        idAsset,
        assetName: asset.Name,
        opportunityName: opportunityData.Name,
        planId,
        dryRun,
        pagosAlquiler: pagos.length,
        pagoCerradoReferencia: pagoCerrado.Name,
        ...extra,
    });

    if (!porCerrar.length) {
        console.log("   No hay pagos pendientes antes del último cerrado: nada por cerrar");
        return armarResultado({ porCerrar: [], abonosCreados: 0 });
    }

    // 6. Abono del pago cerrado, que usaremos como plantilla
    const abonosPlantilla = await sf.getAbonosByPago(pagoCerrado.Id);
    console.log(`6. ABONOS DEL PAGO CERRADO (${pagoCerrado.Name}): ${abonosPlantilla.length}`);
    if (!abonosPlantilla.length) {
        throw Object.assign(new Error("El pago cerrado no tiene abonos que replicar"), { code: "NO_ABONO_PLANTILLA" });
    }
    if (abonosPlantilla.length > 1) {
        console.log(`   ⚠ El pago cerrado tiene ${abonosPlantilla.length} abonos: se usa el último (más reciente)`);
        console.table(
            abonosPlantilla.map((a) => ({
                Id: a.Id,
                Name: a.Name,
                CreatedDate: a.CreatedDate,
                [CAMPO_MONTO_ABONO]: a[CAMPO_MONTO_ABONO],
            }))
        );
    }
    const plantilla = abonosPlantilla[abonosPlantilla.length - 1]; // vienen ordenados por CreatedDate ASC
    console.log("   PLANTILLA DE ABONO", plantilla);


    // Solo se clonan los campos que se pueden crear
    const desc = await sf.describe("Abono__c");
    const creables = new Set(desc.fields.filter((f) => f.createable).map((f) => f.name));

    if (!(CAMPO_MONTO_ABONO in plantilla) || !creables.has(CAMPO_MONTO_ABONO)) {
        console.log(
            "   Campos numéricos del abono:",
            desc.fields.filter((f) => ["currency", "double", "int", "percent"].includes(f.type)).map((f) => f.name)
        );
        throw Object.assign(
            new Error(`El campo ${CAMPO_MONTO_ABONO} no existe o no se puede escribir en Abono__c`),
            { code: "NO_CAMPO_MONTO" }
        );
    }

    // Verificación: ¿el abono de la plantilla coincide con el total de su pago?
    const montoReplicado = Number(plantilla[CAMPO_MONTO_ABONO]);
    console.log("   MONTO A REPLICAR", { campo: CAMPO_MONTO_ABONO, monto: montoReplicado });
    if (!(montoReplicado > 0)) {
        throw Object.assign(
            new Error(`El abono de referencia no tiene monto en ${CAMPO_MONTO_ABONO}`),
            { code: "NO_MONTO_PLANTILLA" }
        );
    }

    const campoFecha = desc.fields.find((f) => f.name === CAMPO_FECHA_COBRO_ABONO);
    if (!campoFecha || !campoFecha.createable || !["date", "datetime"].includes(campoFecha.type)) {
        console.log(
            "   Campos de fecha del abono:",
            desc.fields.filter((f) => ["date", "datetime"].includes(f.type)).map((f) => f.name)
        );
        throw Object.assign(
            new Error(`El campo ${CAMPO_FECHA_COBRO_ABONO} no existe o no es de fecha en Abono__c`),
            { code: "NO_CAMPO_FECHA" }
        );
    }
    // Si es Date/Time, mediodía UTC para que no cambie de día en hora de Panamá
    const valorFecha = (d) =>
        campoFecha.type === "datetime" ? `${formatFecha(d)}T12:00:00.000Z` : formatFecha(d);
    if (campoFecha.length) {
        console.log("   ⚠ Campos de fecha que se copian TAL CUAL de la plantilla (confirmar):", campoFecha);
    }

    const base = {};
    for (const [campo, valor] of Object.entries(plantilla)) {

        if (
            campo === "Name" ||
            campo === "Plan_de_Pago__c"
        ) {
            continue;
        }

        if (creables.has(campo) && valor !== null) {
            base[campo] = valor;
        }
    }

    // 7. Un abono por cada pago a cerrar, por su monto total
    const abonos = [];
    for (const p of porCerrar) {
        // Día 1 del mes (y año) del pago
        const f = parseFecha(p.Fecha__c);
        const fechaAbono = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), 1));

        console.log(
            `   ${p.Name} (${p.Fecha__c}) → abono de ${montoReplicado}, fecha del abono ${formatFecha(fechaAbono)}`
        );
        abonos.push({
            ...base,
            Name: p.Name,
            Pago__c: p.Id,
            [CAMPO_FECHA_COBRO_ABONO]: valorFecha(fechaAbono),
        });
    }
    if (abonos.length) console.log("   Ejemplo del primer abono por crear:", abonos[0]);

    // 8. Crear (o solo simular)
    let abonosCreados = 0;
    let cerradosConfirmados = null;
    if (!dryRun && abonos.length) {
        await sf.createRecords("Abono__c", abonos);
        abonosCreados = abonos.length;

        // ¿El sistema cerró los pagos al insertar los abonos?
        const despues = await sf.getPagosCompletosByPlan(planId);
        const ids = new Set(porCerrar.map((p) => p.Id));
        const afectados = despues.filter((p) => ids.has(p.Id));
        cerradosConfirmados = afectados.filter(esCerrado).length;
        console.log(
            `   VERIFICACIÓN POST-CREACIÓN: ${cerradosConfirmados}/${afectados.length} pagos quedaron en "${ESTADO_PAGO_CERRADO}"`
        );
    }

    console.log(
        dryRun
            ? "=== FIN (dry run, no se creó nada) ==="
            : `=== FIN (${abonosCreados} abonos creados) ===`
    );
    return armarResultado({
        porCerrar: porCerrar.map((p) => p.Name),
        abonosPorCrear: abonos.length,
        abonosCreados,
        cerradosConfirmados,
    });
}

module.exports = { procesarCierreAsset, obtenerPlanAlquilerDeAsset };