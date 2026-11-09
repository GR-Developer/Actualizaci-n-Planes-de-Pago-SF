/**
 * Lógica core para generar pagos de alquiler de un asset.
 * Usada tanto por el endpoint HTTP como por el script CLI.
 */
const sf = require("../services/salesforce");
const { parseFecha, formatFecha, addMonthsWithDay, mesKey } = require("../utils/fechas");

const NOMBRE_ALQUILER_REGEX = /^ALQUILER\s*#?\s*(\d+)\s*$/i;
const RT_PLAN_ALQUILER = "0126g000001P0eQAAS";

function numeroDePago(name) {
    const m = NOMBRE_ALQUILER_REGEX.exec((name || "").trim());
    return m ? parseInt(m[1], 10) : null;
}

/**
 * Procesa un asset: calcula los pagos faltantes y opcionalmente los crea.
 * @param {string} idAsset  - Id del asset en Salesforce
 * @param {boolean} dryRun  - Si true, solo calcula sin crear
 * @returns {object} Resultado con resumen y pagos generados/por crear
 */
async function procesarAsset(idAsset, dryRun = true) {
    console.log("=== INICIO ===", { idAsset, dryRun });

    if (!/^[a-zA-Z0-9]{15,18}$/.test(idAsset)) {
        throw Object.assign(new Error("idAsset inválido"), { code: "INVALID_ID" });
    }

    // 1. Leemos el asset
    const asset = await sf.getRecord("Asset", idAsset);
    const opportunity = asset.Oportunidad__c;
    console.log("1. ASSET", { Id: asset.Id, Name: asset.Name, Oportunidad__c: opportunity });

    if (!opportunity) {
        throw Object.assign(new Error("El asset no tiene oportunidad asociada"), { code: "NO_OPPORTUNITY" });
    }

    // 2. Data de la oportunidad
    const opportunityData = await sf.getRecord("Opportunity", opportunity);
    const Monto_de_alquiler_mensual_actual = opportunityData.Monto_de_alquiler_mensual_actual__c;
    const Fecha_Inicio_de_Contrato = opportunityData.Fecha_Inicio_de_Contrato__c;
    const Fecha_de_fin_de_contrato = opportunityData.Fecha_de_fin_de_contrato__c;
    console.log("2. OPORTUNIDAD", {
        Id: opportunityData.Id,
        Name: opportunityData.Name,
        Monto_de_alquiler_mensual_actual,
        Fecha_Inicio_de_Contrato,
        Fecha_de_fin_de_contrato,
    });

    if (Monto_de_alquiler_mensual_actual == null || Monto_de_alquiler_mensual_actual <= 0) {
        throw Object.assign(new Error("La oportunidad no tiene monto de alquiler mensual"), { code: "NO_MONTO" });
    }
    if (!Fecha_Inicio_de_Contrato || !Fecha_de_fin_de_contrato) {
        throw Object.assign(new Error("La oportunidad no tiene fechas de contrato"), { code: "NO_FECHAS" });
    }

    const inicio = parseFecha(Fecha_Inicio_de_Contrato);
    const fin = parseFecha(Fecha_de_fin_de_contrato);
    if (fin <= inicio) {
        throw Object.assign(new Error("La fecha fin debe ser posterior al inicio"), { code: "FECHA_INVALIDA" });
    }

    // 3. Plan de pago de alquiler
    const planes = await sf.getPlanesByOpportunity(opportunity);
    console.log(`3. PLANES DE LA OPORTUNIDAD: ${planes.length}`);
    if (planes.length) {
        console.table(
            planes.map((p) => ({
                Id: p.Id,
                Name: p.Name,
                RecordTypeId: p.RecordTypeId,
                esAlquiler: p.RecordTypeId === RT_PLAN_ALQUILER,
                inicioPlan: p.Fecha_de_Inicio__c,
                finPlan: p.Fecha_fin_de_contrato__c,
            }))
        );
    }

    if (!planes.length) {
        throw Object.assign(new Error("La oportunidad no tiene plan de pago"), { code: "NO_PLAN" });
    }

    const planesAlquiler = planes.filter((p) => p.RecordTypeId === RT_PLAN_ALQUILER);
    if (!planesAlquiler.length) {
        throw Object.assign(new Error("La oportunidad no tiene un plan de tipo alquiler"), { code: "NO_PLAN_ALQUILER" });
    }
    if (planesAlquiler.length > 1) {
        throw Object.assign(new Error("La oportunidad tiene más de un plan de alquiler"), { code: "MULTIPLE_PLANES" });
    }

    const plan = planesAlquiler[0];
    const planId = plan.Id;
    console.log("   PLAN ELEGIDO", {
        planId,
        fechasPlanCoincidenConOportunidad:
            plan.Fecha_de_Inicio__c === Fecha_Inicio_de_Contrato &&
            plan.Fecha_fin_de_contrato__c === Fecha_de_fin_de_contrato,
        inicioPlan: plan.Fecha_de_Inicio__c,
        finPlan: plan.Fecha_fin_de_contrato__c,
    });

    // 4. Pagos existentes
    const pagosDelPlan = (await sf.getPagosByPlan(planId)).filter((p) => p.Fecha__c);
    console.log(`4. PAGOS DEL PLAN: ${pagosDelPlan.length}`);
    if (pagosDelPlan.length) {
        console.table(
            pagosDelPlan.map((p) => ({
                Id: p.Id,
                Name: p.Name,
                Tipo__c: p.Tipo__c,
                Fecha__c: p.Fecha__c,
                Monto__c: p.Monto__c,
                Monto_Mantenimiento__c: p.Monto_Mantenimiento__c,
                Monto_Agua__c: p.Monto_Agua__c,
                Monto_Estacionamiento__c: p.Monto_Estacionamiento__c,
                Monto_Otros__c: p.Monto_Otros__c,
                numero: numeroDePago(p.Name),
            }))
        );
    }

    const existentes = pagosDelPlan.filter(
        (p) => (p.Tipo__c || "").toLowerCase() === "alquiler"
    );
    console.log(`   PAGOS DE ALQUILER: ${existentes.length}`);

    // Numeración
    const numeros = existentes
        .map((p) => numeroDePago(p.Name))
        .filter((n) => n !== null);
    const sinNumero = existentes.filter((p) => numeroDePago(p.Name) === null);
    if (sinNumero.length) {
        console.log(
            "   ⚠ Pagos de alquiler cuyo Name no sigue el formato 'Alquiler N':",
            sinNumero.map((p) => ({ Id: p.Id, Name: p.Name }))
        );
    }
    const ultimoNumero = numeros.length ? Math.max(...numeros) : 0;
    let siguienteNumero = ultimoNumero + 1;
    console.log("   NUMERACIÓN", { ultimoNumero, siguienteNumero });

    // 5. Punto de partida y concurrencia de días
    const ultimoPago = existentes.length
        ? existentes.reduce((max, p) => (p.Fecha__c > max.Fecha__c ? p : max))
        : null;

    let diaConcurrente;
    if (ultimoPago) {
        diaConcurrente = parseFecha(ultimoPago.Fecha__c).getUTCDate();
    } else {
        diaConcurrente = 1;
    }

    const baseRaw = ultimoPago ? parseFecha(ultimoPago.Fecha__c) : inicio;
    const baseY = baseRaw.getUTCFullYear();
    const baseM = baseRaw.getUTCMonth();
    const ultimoDiaBase = new Date(Date.UTC(baseY, baseM + 1, 0)).getUTCDate();
    const base = new Date(Date.UTC(baseY, baseM, Math.min(diaConcurrente, ultimoDiaBase)));
    const mesInicial = ultimoPago ? 1 : 0;

    console.log("5. FECHAS", {
        inicio: formatFecha(inicio),
        fin: formatFecha(fin),
        ultimoPago: ultimoPago ? { Name: ultimoPago.Name, Fecha__c: ultimoPago.Fecha__c } : null,
        diaConcurrente,
        base: formatFecha(base),
        baseEs: ultimoPago
            ? `último pago de alquiler, día fijo: ${diaConcurrente} (se crea desde el mes siguiente)`
            : `sin pagos previos, día fijo: 1 (primero de cada mes)`,
    });
    if (ultimoPago && base >= fin) {
        console.log("   El último pago ya alcanza la fecha fin del contrato: no hay nada por crear");
    }

    // Montos del último pago
    const montoAlquiler = ultimoPago && ultimoPago.Monto__c != null
        ? ultimoPago.Monto__c
        : Monto_de_alquiler_mensual_actual;
    const montoMantenimiento = ultimoPago ? (ultimoPago.Monto_Mantenimiento__c || 0) : 0;
    const montoAgua = ultimoPago ? (ultimoPago.Monto_Agua__c || 0) : 0;
    const montoEstacionamiento = ultimoPago ? (ultimoPago.Monto_Estacionamiento__c || 0) : 0;
    const montoOtros = ultimoPago ? (ultimoPago.Monto_Otros__c || 0) : 0;

    console.log("   MONTOS A REPLICAR", {
        fuente: ultimoPago ? "último pago existente" : "oportunidad (sin pagos previos)",
        montoAlquiler,
        montoMantenimiento,
        montoAgua,
        montoEstacionamiento,
        montoOtros,
    });

    // 6. Generar pagos nuevos
    const nuevos = [];

    for (let i = mesInicial; i < 600; i++) {
        let fecha = addMonthsWithDay(base, i, diaConcurrente);

        if (fecha >= fin) {
            const mismoMes =
                fecha.getUTCFullYear() === fin.getUTCFullYear() &&
                fecha.getUTCMonth() === fin.getUTCMonth();
            if (mismoMes) {
                fecha = new Date(fin);
                console.log(
                    `   ⚠ Día concurrente (${diaConcurrente}) cae después del fin de contrato en ${mesKey(fin)}. ` +
                    `Se usa la fecha de fin: ${formatFecha(fecha)}`
                );
            } else {
                break;
            }
        }

        const numero = siguienteNumero++;
        console.log(`   mes ${mesKey(fecha)} (${formatFecha(fecha)}) → ALQUILER ${numero}`);
        nuevos.push({
            Name: `ALQUILER ${numero}`,
            Plan_de_Pago__c: planId,
            Descripci_n__c: "ALQUILER",
            Estado__c: "Pendiente",
            Tipo__c: "Alquiler",
            Monto__c: montoAlquiler,
            Monto_Mantenimiento__c: montoMantenimiento,
            Monto_Agua__c: montoAgua,
            Monto_Estacionamiento__c: montoEstacionamiento,
            Monto_Otros__c: montoOtros,
            Fecha__c: formatFecha(fecha),
            RecordTypeId: "012TN000003t7iHYAQ",
            Lleva_ITBMS__c: false,
        });

        if (fecha.getTime() === fin.getTime()) break;
    }

    console.log("6. RESUMEN", {
        existentes: existentes.length,
        ultimoNumero,
        porCrear: nuevos.length,
        primeraFecha: nuevos[0]?.Fecha__c,
        ultimaFecha: nuevos[nuevos.length - 1]?.Fecha__c,
    });
    if (nuevos.length) console.log("   Ejemplo del primer pago por crear:", nuevos[0]);

    // 7. Crear (o solo simular)
    let creados = 0;
    if (!dryRun && nuevos.length) {
        await sf.createRecords("Pago__c", nuevos);
        creados = nuevos.length;
    }

    const resultado = {
        idAsset,
        assetName: asset.Name,
        opportunityId: opportunity,
        opportunityName: opportunityData.Name,
        planId,
        dryRun,
        Monto_de_alquiler_mensual_actual,
        montoAlquiler,
        montoMantenimiento,
        Fecha_Inicio_de_Contrato,
        Fecha_de_fin_de_contrato,
        existentes: existentes.length,
        creados,
        porCrear: nuevos,
    };

    console.log(dryRun ? "=== FIN (dry run, no se creó nada) ===" : `=== FIN (${creados} pagos creados) ===`);
    return resultado;
}

module.exports = { procesarAsset, numeroDePago, RT_PLAN_ALQUILER };
