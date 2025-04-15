const express = require("express");
const { createStock, stockListByProduct, stockListBySales,
    stockListBySubAgent, stockListByAgent, getStockTable, getStockClientTable,
    getStockHistory, settlingStock, cancelingStock, getStockResume,
    getTableBySalesId, createStockBatch, getTableByShopId, settleStockBatch,
    getStockBatches, cancelStockBatch, getTableBySubAgentId, getTableByAgentId
} = require("../controllers/stockController");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

router.post("/", authMiddleware, createStock);
router.get("/product/:productId", authMiddleware, stockListByProduct);
router.get("/sales/:salesId", authMiddleware, stockListBySales);
router.get("/subagent/:subAgentId", authMiddleware, stockListBySubAgent);
router.get("/agent/:agentId", authMiddleware, stockListByAgent);
router.get("/history", authMiddleware, getStockHistory);
router.get("/table", authMiddleware, getStockTable);
router.get("/table/client", authMiddleware, getStockClientTable);
router.put("/settled", authMiddleware, settlingStock);
router.put("/canceled", authMiddleware, cancelingStock);
router.post("/table/resume", authMiddleware, getStockResume);
router.post("/table/salesman", authMiddleware, getTableBySalesId);
router.post("/table/subAgent", authMiddleware, getTableBySubAgentId);
router.post("/table/agent", authMiddleware, getTableByAgentId);
router.post("/table/shop", authMiddleware, getTableByShopId);
router.post("/batch", authMiddleware, createStockBatch);
router.get("/batches", authMiddleware, getStockBatches);
router.put("/batch/:batchId/settle", authMiddleware, settleStockBatch);
// --- Add the PUT route for canceling a batch ---
router.put("/batch/:batchId/cancel", authMiddleware, cancelStockBatch);
// --- End of addition ---

module.exports = router;
