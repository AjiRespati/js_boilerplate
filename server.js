require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const logger = require("./config/logger");
const { sequelize } = require("./models");

const app = express();

// ✅ Middlewares
app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(morgan("combined", { stream: { write: (message) => logger.info(message.trim()) } }));

// ✅ Routes
const authRoutes = require("./routes/authRoutes");

// ✅ Serve Static Files (Fix the Image Error)
app.use('/api/uploads', express.static('uploads'));

// ✅ Register Routes
app.use("/api/auth", authRoutes);

// ✅ Sync Database & Start Server
const PORT = process.env.PORT || 5000;

sequelize.sync({ alter: true })
    .then(() => {
        logger.info("✅ Database synchronized successfully.");
        app.listen(PORT, () => logger.info(`🚀 Server running on port ${PORT}`));
    })
    .catch((err) => {
        console.log(err);
        logger.error("❌ Database sync error:", err.stack);
    });
