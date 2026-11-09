const express = require("express");
const salesforceRoutes = require("./routes/salesforce.routes");

const app = express();
app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.use("/api/salesforce", salesforceRoutes);


// Manejo de errores
app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).json({
        error: err.message,
        details: err.details,
    });
});

module.exports = app;