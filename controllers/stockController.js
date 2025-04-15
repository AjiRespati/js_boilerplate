const db = require("../models");
const sequelize = db.sequelize;
const Sequelize = db.Sequelize;
const { Op } = Sequelize;
const { Stock, Metric, Price, Percentage, SalesmanCommission, SubAgentCommission,
    AgentCommission, DistributorCommission, ShopAllCommission, StockBatch, Product, User } = require("../models");
const logger = require("../config/logger");


// --- Internal Helper: Create ONE Stock entry (part of a batch) ---
// Defers actual stock level calculation and commission generation to settlement
async function _internalCreateSingleStock(itemData, transaction, username, batchId) {
    const { metricId, stockEvent, amount, salesId, subAgentId, agentId, shopId, description } = itemData;

    // Price fetching is still needed at creation to store the price context
    const latestPrice = await Price.findOne({
        where: { metricId }, order: [["createdAt", "DESC"]], transaction
    });

    if (!latestPrice) {
        throw new Error(`No price available for metricId ${metricId}`);
    }

    // Store prices captured at the time of creation
    const totalPrice = amount * latestPrice.price;
    const totalNetPrice = amount * latestPrice.netPrice; // Assuming netPrice is available
    const salesmanPrice = salesId ? amount * latestPrice.salesmanPrice : 0;
    const subAgentPrice = subAgentId ? amount * latestPrice.subAgentPrice : 0;
    const agentPrice = agentId ? amount * latestPrice.agentPrice : 0;

    const stock = await Stock.create({
        metricId,
        stockEvent,
        initialAmount: null, // Calculated at settlement
        amount,             // The amount for THIS specific transaction
        updateAmount: null, // Calculated at settlement
        totalPrice,         // Store price context
        totalNetPrice,      // Store price context
        salesmanPrice,      // Store price context
        subAgentPrice,      // Store price context
        agentPrice,         // Store price context
        totalDistributorShare: 0, // Calculated at settlement
        totalSalesShare: 0,       // Calculated at settlement
        totalSubAgentShare: 0,    // Calculated at settlement
        totalAgentShare: 0,       // Calculated at settlement
        totalShopShare: 0,        // Calculated at settlement
        createdBy: username,
        salesId,
        subAgentId,
        agentId,
        shopId,
        status: "created", // Initial status
        description,
        stockBatchId: batchId // Link to the batch
    }, { transaction });

    return stock;
}


// --- Controller: Create Stocks in Batch ---
exports.createStockBatch = async (req, res) => {
    const { transactions } = req.body;
    const username = req.user.username;
    const userId = req.user.id;
    const user = await User.findOne({ where: { id: req.user.id } });
    if (!user) return res.status(400).json({ message: 'Invalid user' });
    const userDesc = user.levelDesc;

    let batchRecord = null;



    if (!Array.isArray(transactions) || transactions.length === 0) {
        return res.status(400).json({ error: "Request body must contain a non-empty 'transactions' array." });
    }

    // 1. Create StockBatch Record (outside main transaction)
    try {
        batchRecord = await StockBatch.create({
            batchType: 'stock_creation',
            status: 'processing',
            itemCount: transactions.length,
            createdBy: username,
            creatorId: userId,
            userDesc: userDesc,
        });
    } catch (batchError) {
        logger.error(`Failed to create initial StockBatch record: ${batchError.stack}`);
        return res.status(500).json({ error: "Failed to initiate batch process." });
    }

    // 2. Transaction for Creating Stock Entries
    const stockTransaction = await sequelize.transaction();
    try {
        const createdStocks = [];
        // Use Promise.all for concurrent creation within the transaction
        await Promise.all(transactions.map(async (item) => {
            const newStock = await _internalCreateSingleStock(item, stockTransaction, username, batchRecord.id);
            createdStocks.push(newStock);
        }));

        // 3a. Commit Stock Transaction
        await stockTransaction.commit();

        // 4a. Update Batch Record Status (Success)
        try {
            batchRecord.status = 'completed';
            batchRecord.successCount = createdStocks.length;
            batchRecord.failureCount = 0;
            await batchRecord.save();
            logger.info(`StockBatch ${batchRecord.id} completed successfully.`);
            res.status(201).json({
                message: "Batch stock creation successful",
                batchId: batchRecord.id,
                data: createdStocks
            });
        } catch (updateError) {
            logger.error(`Failed to update StockBatch ${batchRecord.id} status to completed: ${updateError.stack}`);
            res.status(201).json({ // Stocks were created, but batch status update failed
                message: "Batch stock creation successful, but failed to update batch status.",
                batchId: batchRecord.id,
                data: createdStocks
            });
        }

    } catch (error) {
        // 3b. Rollback Stock Transaction
        await stockTransaction.rollback();

        // 4b. Update Batch Record Status (Failure)
        try {
            batchRecord.status = 'failed';
            batchRecord.successCount = 0;
            batchRecord.failureCount = batchRecord.itemCount;
            batchRecord.errorMessage = error.message;
            await batchRecord.save();
            logger.error(`StockBatch ${batchRecord.id} failed: ${error.message}`);
        } catch (updateError) {
            logger.error(`Failed to update StockBatch ${batchRecord.id} status to failed: ${updateError.stack}`);
        }

        logger.error(`Batch stock creation failed: ${error.stack}`);
        res.status(500).json({
            error: "Batch stock creation failed",
            batchId: batchRecord.id,
            details: error.message
        });
    }
};


// --- Internal Helper: Settle ONE Stock (calculates levels, commissions) ---
async function _internalSettleSingleStock(stockInstance, transaction, username) {
    if (stockInstance.status !== 'created') {
        logger.warn(`Attempted to settle Stock ID ${stockInstance.id} which is not in 'created' status (Current: ${stockInstance.status}). Skipping.`);
        // Decide whether to throw an error or just skip. Skipping might be okay if re-running settlement.
        // For safety, let's throw to ensure atomicity unless explicitly designed otherwise.
        throw new Error(`Stock ID ${stockInstance.id} is not in 'created' status.`);
        // return; // Alternative: just skip this one
    }

    const { id, metricId, stockEvent, amount, salesId, subAgentId, agentId } = stockInstance;
    const totalNetPrice = stockInstance.totalNetPrice; // Use stored net price

    // --- Calculate stock levels at settlement time ---
    let initialAmountAtSettlement = 0;
    const lastSettledStockBeforeThis = await Stock.findOne({
        where: { metricId, status: "settled" },
        order: [["updatedAt", "DESC"], ["id", "DESC"]], // Order reliably
        transaction
    });

    if (lastSettledStockBeforeThis) {
        initialAmountAtSettlement = lastSettledStockBeforeThis.updateAmount || 0; // Handle null case
    }

    const updateAmountAtSettlement = stockEvent === 'stock_in'
        ? initialAmountAtSettlement + amount
        : initialAmountAtSettlement - amount;

    if (stockEvent === 'stock_out' && updateAmountAtSettlement < 0) { // Only check for stock_out
        throw new Error(`Not enough stock for metricId ${metricId} when settling stock ID ${id}. Required: ${amount}, Available: ${initialAmountAtSettlement}`);
    }
    // --- End stock level calculation ---

    // --- Commission Calculation ---
    const percentages = await Percentage.findAll({ transaction });
    const percentageMap = {};
    percentages.forEach(p => { percentageMap[p.key] = p.value; });
    let distributorPercentage = 0;
    let totalDistributorShare = 0;
    let totalSalesShare = null;
    let totalSubAgentShare = null;
    let totalAgentShare = null;
    let totalShopShare = null;

    if (salesId) {
        distributorPercentage = 100 - (percentageMap["supplier"] || 0) - (percentageMap["shop"] || 0) - (percentageMap["salesman"] || 0);
        totalDistributorShare = totalNetPrice * distributorPercentage / 100;
        totalSalesShare = totalNetPrice * (percentageMap["salesman"] || 0) / 100;
    } else if (subAgentId) {
        distributorPercentage = 100 - (percentageMap["supplier"] || 0) - (percentageMap["shop"] || 0) - (percentageMap["subAgent"] || 0);
        totalDistributorShare = totalNetPrice * distributorPercentage / 100;
        totalSubAgentShare = totalNetPrice * (percentageMap["subAgent"] || 0) / 100;
    } else if (agentId) {
        distributorPercentage = 100 - (percentageMap["supplier"] || 0) - (percentageMap["agent"] || 0); // Agent might not involve shop %? Check logic.
        totalDistributorShare = totalNetPrice * distributorPercentage / 100;
        totalAgentShare = totalNetPrice * (percentageMap["agent"] || 0) / 100;
    } // else: No specific seller type, distributor share remains 0 unless other logic applies

    // Calculate shop share if it's a stock_out and there's a relevant seller OR if it always applies
    if (stockEvent === 'stock_out' && (salesId || subAgentId || agentId)) { // Example condition
        totalShopShare = totalNetPrice * (percentageMap["shop"] || 0) / 100;
    }
    // --- End Commission Calculation ---


    // --- Update Stock Instance ---
    stockInstance.status = "settled";
    stockInstance.initialAmount = initialAmountAtSettlement;
    stockInstance.updateAmount = updateAmountAtSettlement;
    stockInstance.totalSalesShare = totalSalesShare;
    stockInstance.totalDistributorShare = totalDistributorShare;
    stockInstance.totalSubAgentShare = totalSubAgentShare;
    stockInstance.totalAgentShare = totalAgentShare;
    stockInstance.totalShopShare = totalShopShare;
    stockInstance.settledBy = username;
    await stockInstance.save({ transaction });
    // --- End Stock Update ---


    // --- Create Commission Records ---
    const commissionData = { stockId: id, totalNetPrice, createdBy: username };
    if (salesId && totalSalesShare !== null) {
        await SalesmanCommission.create({ ...commissionData, salesId, percentage: percentageMap["salesman"], amount: totalSalesShare }, { transaction });
    } else if (subAgentId && totalSubAgentShare !== null) {
        await SubAgentCommission.create({ ...commissionData, subAgentId, percentage: percentageMap["subAgent"], amount: totalSubAgentShare }, { transaction });
    } else if (agentId && totalAgentShare !== null) {
        await AgentCommission.create({ ...commissionData, agentId, percentage: percentageMap["agent"], amount: totalAgentShare }, { transaction });
    }

    if (totalDistributorShare > 0) { // Only create if there's a share
        await DistributorCommission.create({ ...commissionData, percentage: distributorPercentage, amount: totalDistributorShare }, { transaction });
    }

    if (totalShopShare !== null && totalShopShare !== 0) { // Only create if there's a share
        await ShopAllCommission.create({ ...commissionData, salesId, subAgentId, agentId, percentage: percentageMap["shop"], amount: totalShopShare }, { transaction });
    }
    // --- End Commission Records ---

    logger.info(`Stock ID ${id} settled successfully within transaction by ${username}.`);
}


// --- Controller: Settle Stocks in Batch ---
exports.settleStockBatch = async (req, res) => {
    const { batchId } = req.params;
    const username = req.user.username;
    let batchRecord = null;
    const settlementTransaction = await sequelize.transaction();

    try {
        // 1. Find and Lock Batch Record
        batchRecord = await StockBatch.findByPk(batchId, {
            lock: settlementTransaction.LOCK.UPDATE,
            transaction: settlementTransaction
        });

        if (!batchRecord) {
            await settlementTransaction.rollback();
            return res.status(404).json({ error: `StockBatch with ID ${batchId} not found.` });
        }

        // 2. Validate Batch Status
        if (batchRecord.status !== 'completed') {
            await settlementTransaction.rollback();
            return res.status(400).json({ error: `StockBatch ${batchId} cannot be settled. Current status: ${batchRecord.status}. Expected: completed.` });
        }

        // 3. Find Associated 'created' Stocks
        const stocksToSettle = await Stock.findAll({
            where: { stockBatchId: batchId, status: 'created' },
            transaction: settlementTransaction // Important: find within transaction
        });

        if (stocksToSettle.length === 0) {
            logger.warn(`StockBatch ${batchId} settlement requested, but no stock entries found in 'created' status.`);
            batchRecord.status = 'settled'; // Mark batch as settled
            await batchRecord.save({ transaction: settlementTransaction });
            await settlementTransaction.commit();
            return res.status(200).json({ message: `Batch ${batchId} already settled or had no items needing settlement.`, affectedCount: 0 });
        }

        // 4. Settle Each Stock (Sequentially Recommended for stock levels)
        let settledCount = 0;
        let errorsDuringSettlement = [];
        for (const stock of stocksToSettle) {
            try {
                await _internalSettleSingleStock(stock, settlementTransaction, username);
                settledCount++;
            } catch (settleError) {
                logger.error(`Error settling Stock ID ${stock.id} within batch ${batchId}: ${settleError.message}`);
                errorsDuringSettlement.push({ stockId: stock.id, error: settleError.message });
                // Decide whether to continue or stop on first error. Stopping ensures full atomicity.
                throw settleError; // Re-throw to trigger main catch block and rollback
            }
        }

        // 5. Update Batch Status
        batchRecord.status = 'settled';
        batchRecord.successCount = settledCount; // Record how many actually got processed before commit/error
        batchRecord.failureCount = errorsDuringSettlement.length; // Should be 0 if commit is reached
        await batchRecord.save({ transaction: settlementTransaction });

        // 6. Commit Transaction
        await settlementTransaction.commit();

        logger.info(`StockBatch ${batchId} settled successfully by ${username}. ${settledCount} stock entries updated.`);
        res.status(200).json({ message: `Batch ${batchId} settled successfully.`, affectedCount: settledCount });

    } catch (error) {
        // 7. Rollback on Any Error
        await settlementTransaction.rollback();

        // 8. Attempt to Update Batch Status to Failed (outside original transaction)
        if (batchRecord) { // Check if batchRecord was fetched
            try {
                // Fetch the record again to update it, as the instance might be stale after rollback
                await StockBatch.update(
                    { status: 'failed', errorMessage: `Settlement failed: ${error.message}` },
                    { where: { id: batchId, status: { [Op.not]: 'settled' } } } // Avoid overwriting if somehow settled
                );
                logger.error(`Updated StockBatch ${batchId} status to failed after settlement rollback.`);
            } catch (updateError) {
                logger.error(`Failed to update StockBatch ${batchId} status after settlement rollback: ${updateError.stack}`);
            }
        }

        logger.error(`Failed to settle StockBatch ${batchId}: ${error.stack}`);
        res.status(500).json({ error: "Failed to settle stock batch", details: error.message });
    }
};


// --- NEW: Controller to Get Stock Batches ---
exports.getStockBatches = async (req, res) => {
    try {
        // --- Pagination ---
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 10;
        const offset = (page - 1) * limit;

        // --- Filtering ---
        const whereClause = {};
        // (Filtering logic remains the same as before)
        if (req.query.status && req.query.status !== 'all') {
            whereClause.status = req.query.status;
        } else if (!req.query.status) {
            whereClause.status = 'completed'; // Default filter
        }
        if (req.query.createdBy) {
            whereClause.createdBy = req.query.createdBy;
        }
        if (req.query.startDate && req.query.endDate) {
            whereClause.createdAt = {
                [Op.between]: [new Date(req.query.startDate), new Date(req.query.endDate)]
            };
        } else if (req.query.startDate) {
            whereClause.createdAt = { [Op.gte]: new Date(req.query.startDate) };
        } else if (req.query.endDate) {
            whereClause.createdAt = { [Op.lte]: new Date(req.query.endDate) };
        }


        // --- Sorting ---
        const sortBy = req.query.sortBy || 'createdAt';
        const sortOrder = req.query.sortOrder || 'DESC';
        const order = [[sortBy, sortOrder.toUpperCase()]];

        // --- Fetch Data with Count and Nested Includes ---
        const { count, rows: rawBatches } = await StockBatch.findAndCountAll({ // Renamed rows to rawBatches
            where: whereClause,
            limit: limit,
            offset: offset,
            order: order,
            distinct: true,
            include: [
                {
                    // Use model name 'Stock' if no alias 'stockEntries' is set in StockBatch model
                    model: Stock, // Use 'Stock' here since your response shows 'Stocks' key
                    // as: 'stockEntries', // Use this line if you add the alias to the model
                    attributes: [ // Select fields from Stock model needed for final output
                        'id',
                        'amount',
                        'stockEvent',
                        // 'metricId', // Keep metricId if needed
                        'totalPrice',
                        'totalNetPrice', // Make sure this exists in your Stock model/DB
                        'salesmanPrice',
                        'subAgentPrice',
                        'agentPrice'
                    ],
                    required: false,
                    include: [
                        {
                            model: Metric,
                            attributes: ['id', 'metricType', 'productId'], // Select fields needed from Metric
                            required: false,
                            include: [
                                {
                                    model: Product,
                                    attributes: ['id', 'name'], // Select fields needed from Product
                                    required: false,
                                }
                            ]
                        }
                    ]
                }
            ]
            // If selecting top-level attributes, do it here
            // attributes: ['id', 'status', 'itemCount', 'createdBy', 'createdAt', 'updatedAt', /* etc */],
        });

        // --- Post-Processing: Flatten the nested structure ---
        const processedData = rawBatches.map(batchInstance => {
            // Convert Sequelize instance to plain object
            const batch = batchInstance.get({ plain: true });

            // Check if Stocks array exists and process it
            if (batch.Stocks && Array.isArray(batch.Stocks)) {
                batch.Stocks = batch.Stocks.map(stock => {
                    // Prepare the flattened stock object
                    const flattenedStock = {
                        // Copy direct stock fields
                        id: stock.id,
                        amount: stock.amount,
                        stockEvent: stock.stockEvent,
                        // metricId: stock.metricId,  // no metricId
                        totalPrice: stock.totalPrice,
                        totalNetPrice: stock.totalNetPrice,
                        salesmanPrice: stock.salesmanPrice,
                        subAgentPrice: stock.subAgentPrice,
                        agentPrice: stock.agentPrice,
                        // Add other stock fields as needed
                    };

                    // Flatten Metric and Product info if they exist
                    if (stock.Metric) {
                        flattenedStock.metricType = stock.Metric.metricType;
                        flattenedStock.productId = stock.Metric.productId; // Keep productId if needed

                        if (stock.Metric.Product) {
                            // Use 'productName' key in response for clarity, maps from 'name' field
                            flattenedStock.productName = stock.Metric.Product.name;
                        } else {
                            flattenedStock.productName = null; // Handle case where Product might be missing
                        }
                    } else {
                        // Handle case where Metric might be missing
                        flattenedStock.metricType = null;
                        flattenedStock.productId = null;
                        flattenedStock.productName = null;
                    }
                    return flattenedStock;
                });
            } else {
                // Ensure the key exists even if empty, consistent with structure
                batch.Stocks = [];
            }
            return batch; // Return the modified batch object
        });
        // --- End Post-Processing ---


        // --- Format Response ---
        const totalPages = Math.ceil(count / limit);
        res.status(200).json({
            message: "Stock batches retrieved successfully.",
            data: processedData, // Use the processed data with flattened structure
            pagination: {
                totalItems: count,
                totalPages: totalPages,
                currentPage: page,
                itemsPerPage: limit
            }
        });

    } catch (error) {
        logger.error(`Error retrieving stock batches: ${error.stack}`);
        if (error instanceof Sequelize.BaseError) {
            logger.error(`Sequelize Error Details: ${JSON.stringify(error, null, 2)}`);
        }
        res.status(500).json({ error: "Failed to retrieve stock batches", details: error.message });
    }
};

// --- NEW: Controller to Cancel a Stock Batch and Associated Stocks ---
exports.cancelStockBatch = async (req, res) => {
    const { batchId } = req.params;
    const username = req.user.username; // Assumes username is available in req.user

    // Use a transaction to ensure atomicity
    const transaction = await sequelize.transaction();
    let batchRecord = null; // Define batchRecord scope

    try {
        // 1. Find the StockBatch record and lock it
        batchRecord = await StockBatch.findByPk(batchId, {
            lock: transaction.LOCK.UPDATE, // Lock the row during transaction
            transaction: transaction
        });

        if (!batchRecord) {
            await transaction.rollback();
            return res.status(404).json({ error: `StockBatch with ID ${batchId} not found.` });
        }

        // 2. Validate if the batch can be canceled
        // Allow cancellation primarily for 'completed' batches before settlement.
        // You might adjust this logic (e.g., allow canceling 'processing' if needed, but that's complex).
        const cancelableStatuses = ['completed', 'processing']; // Define which statuses can be canceled
        if (!cancelableStatuses.includes(batchRecord.status)) {
            await transaction.rollback();
            return res.status(400).json({ error: `StockBatch ${batchId} cannot be canceled. Current status: ${batchRecord.status}. Required: ${cancelableStatuses.join(' or ')}.` });
        }


        // 3. Update associated Stock entries to 'canceled'
        // Only cancel stocks that are in 'created' status within this batch.
        const [affectedStocksCount] = await Stock.update(
            {
                status: 'canceled',
                canceledBy: username // Record who canceled the stock entry
            },
            {
                where: {
                    stockBatchId: batchId,
                    status: 'created' // Only target 'created' stocks for cancellation
                },
                transaction: transaction // Perform within the transaction
            }
        );

        // 4. Update the StockBatch status to 'canceled'
        batchRecord.status = 'canceled';
        batchRecord.canceledBy = username; // Record who canceled the batch
        // Optionally clear success/failure counts if cancellation means they are irrelevant
        // batchRecord.successCount = null;
        // batchRecord.failureCount = null;
        await batchRecord.save({ transaction: transaction }); // Save within the transaction

        // 5. Commit the transaction
        await transaction.commit();

        logger.info(`StockBatch ${batchId} canceled successfully by ${username}. ${affectedStocksCount} stock entries updated to 'canceled'.`);
        res.status(200).json({
            message: `Batch ${batchId} canceled successfully.`,
            affectedStocksCount: affectedStocksCount
        });

    } catch (error) {
        // Rollback transaction on any error
        await transaction.rollback();

        // Attempt to update batch status to failed if it makes sense in your workflow
        // Otherwise, just log the error.
        if (batchRecord && batchRecord.status !== 'canceled') { // Check if batchRecord was fetched and not already canceled
            try {
                await StockBatch.update(
                    { status: 'failed', errorMessage: `Cancellation failed: ${error.message}` },
                    { where: { id: batchId } } // Update outside rolled-back transaction
                );
                logger.error(`Attempted to mark StockBatch ${batchId} as failed after cancellation rollback.`);
            } catch (updateError) {
                logger.error(`Failed to update StockBatch ${batchId} status after cancellation rollback: ${updateError.stack}`);
            }
        }


        logger.error(`Failed to cancel StockBatch ${batchId}: ${error.stack}`);
        res.status(500).json({ error: "Failed to cancel stock batch", details: error.message });
    }
};


exports.createStock = async (req, res) => {
    try {
        const { metricId, stockEvent, amount, salesId, subAgentId, agentId, shopId, status, description } = req.body;

        let initialAmount = null;
        const lastStock = await Stock.findOne({ where: { metricId, status: "settled" }, order: [["createdAt", "DESC"]] });
        if (lastStock) {
            initialAmount = lastStock.updateAmount && stockEvent === 'stock_in' ? lastStock.updateAmount : null;
        }

        const updateAmount = stockEvent === 'stock_in' ? initialAmount + amount : null;

        // ✅ Fetch the latest price for this metric
        const latestPrice = await Price.findOne({ where: { metricId }, order: [["createdAt", "DESC"]] });
        if (!latestPrice) return res.status(400).json({ error: "No price available for this metric" });

        // ✅ Calculate stock values
        const totalPrice = amount * latestPrice.price;
        const totalNetPrice = amount * latestPrice.netPrice;
        const salesmanPrice = salesId ? amount * latestPrice.salesmanPrice : 0;
        const subAgentPrice = subAgentId ? amount * latestPrice.subAgentPrice : 0;
        const agentPrice = agentId ? amount * latestPrice.agentPrice : 0;

        let totalDistributorShare = 0;
        let totalSalesShare = null;
        let totalSubAgentShare = null;
        let totalAgentShare = null;
        let totalShopShare = null;

        // ✅ Create Stock Entry
        const stock = await Stock.create({
            metricId,
            stockEvent,
            initialAmount,
            amount,
            updateAmount,
            totalPrice,
            totalNetPrice,
            salesmanPrice,
            subAgentPrice,
            agentPrice,
            totalDistributorShare,
            totalSalesShare,
            totalSubAgentShare,
            totalAgentShare,
            totalShopShare,
            createdBy: req.user.username,
            salesId,
            subAgentId,
            agentId,
            shopId,
            status: "created",
            // status: stockEvent === 'stock_in' ? "settled" : "created",
            description
        });

        logger.info(`Stock ${stockEvent} created for metric ${metricId}`);
        res.status(200).json(stock);
    } catch (error) {
        logger.error(`Stock creation error: ${error.stack}`);
        res.status(500).json({ error: "Stock creation failed" });
    }
};


exports.stockListByProduct = async (req, res) => {
    try {
        const { productId } = req.params;

        // ✅ Get all metric IDs for this product
        const metrics = await Metric.findAll({ where: { productId } });
        const metricIds = metrics.map(m => m.id);

        const stocks = await Stock.findAll({ where: { metricId: metricIds } });

        res.json(stocks);
    } catch (error) {
        logger.error(`Fetching stock by product error: ${error.stack}`);
        res.status(500).json({ error: "Failed to retrieve stock records" });
    }
};


exports.stockListBySales = async (req, res) => {
    try {
        const { salesId } = req.params;
        const stocks = await Stock.findAll({ where: { salesId } });

        res.json(stocks);
    } catch (error) {
        logger.error(`Fetching stock by salesman error: ${error.stack}`);
        res.status(500).json({ error: "Failed to retrieve stock records" });
    }
};


exports.stockListBySubAgent = async (req, res) => {
    try {
        const { subAgentId } = req.params;
        const stocks = await Stock.findAll({ where: { subAgentId } });

        res.json(stocks);
    } catch (error) {
        logger.error(`Fetching stock by sub-agent error: ${error.stack}`);
        res.status(500).json({ error: "Failed to retrieve stock records" });
    }
};


exports.stockListByAgent = async (req, res) => {
    try {
        const { agentId } = req.params;
        const stocks = await Stock.findAll({ where: { agentId } });

        res.json(stocks);
    } catch (error) {
        logger.error(`Fetching stock by agent error: ${error.stack}`);
        res.status(500).json({ error: "Failed to retrieve stock records" });
    }
};


exports.getStockHistory = async (req, res) => {
    const { metricId, fromDate, toDate, status } = req.query;

    try {
        const query = `
            SELECT 
                s.id AS "stockId",
                p."name" AS "productName",
                m."metricType" AS "measurement", 
                s."createdAt",
                s."stockEvent",
                s."initialAmount",
                s."amount",
                s."updateAmount",
                s."totalPrice",
                s."totalNetPrice",
                s."agentPrice",
                s."subAgentPrice",
                s."salesmanPrice",
                s."totalDistributorShare",
                s."totalSalesShare",
                s."totalSubAgentShare",
                s."totalAgentShare",
                s."totalShopShare",
                s."status",
                s."description",
                s."createdBy",
                COALESCE(sa.name, ag.name, sm.name, sh.name, 'N/A') AS "relatedEntity",
                CASE 
                    WHEN s."salesId" IS NOT NULL THEN 'Salesman'
                    WHEN s."subAgentId" IS NOT NULL THEN 'SubAgent'
                    WHEN s."agentId" IS NOT NULL THEN 'Agent'
                    WHEN s."shopId" IS NOT NULL THEN 'Shop'
                    ELSE 'Unknown'
                END AS "entityType"
            FROM "Stocks" s
            LEFT JOIN "Metrics" m ON s."metricId" = m.id
            LEFT JOIN "Products" p ON m."productId" = p.id
            LEFT JOIN "Salesmans" sm ON s."salesId" = sm.id
            LEFT JOIN "SubAgents" sa ON s."subAgentId" = sa.id
            LEFT JOIN "Agents" ag ON s."agentId" = ag.id
            LEFT JOIN "Shops" sh ON s."shopId" = sh.id
            WHERE 
                s."metricId" = :metricId
                AND (:fromDate IS NULL OR s."createdAt" >= :fromDate)
                AND (:toDate IS NULL OR s."createdAt" <= :toDate)
                AND (s."status" = :status)
            ORDER BY s."createdAt" DESC;
        `;

        const [results] = await sequelize.query(query, {
            replacements: { metricId, fromDate, toDate, status }
        });

        res.json(results);
    } catch (error) {
        console.error("❌ Stock History Error:", error);
        res.status(500).json({ error: "Failed to fetch stock history" });
    }
};


exports.getStockTable = async (req, res) => {
    const { fromDate, toDate, status, salesId, subAgentId, agentId } = req.query;

    // Ensure that optional parameters default to null if they are missing (undefined)
    // This ensures the replacements object will always have these keys defined.
    const reqSalesId = salesId || null;
    const reqSubAgentId = subAgentId || null;
    const reqAgentId = agentId || null;

    try {
        const query = `
            SELECT 
                p.id AS "productId",
                p.name AS "productName",
                p.image AS "image",
                m.id AS "metricId",
                m."metricType" AS "metricName",
            --    s."totalPrice" AS "basicPrice",
            --    s."agentPrice" AS "agentPrice",
            --    s."subAgentPrice" AS "subAgentPrice",
            --    s."salesmanPrice" AS "salesmanPrice",
                SUM(CASE WHEN s."stockEvent" = 'stock_in' THEN s.amount ELSE 0 END) AS "totalStockIn",
                SUM(CASE WHEN s."stockEvent" = 'stock_out' THEN s.amount ELSE 0 END) AS "totalStockOut",
                (
                    SELECT s2."createdAt"
                    FROM "Stocks" s2
                    WHERE s2."metricId" = m.id
                    ORDER BY s2."createdAt" DESC
                    LIMIT 1
                ) AS "lastStockUpdate",
                (
                    SELECT s3."updateAmount"
                    FROM "Stocks" s3
                    WHERE s3."metricId" = m.id AND s3."status" = 'settled'
                    ORDER BY s3."createdAt" DESC
                    LIMIT 1
                ) AS "latestUpdateAmount"
            FROM "Stocks" s
            LEFT JOIN "Metrics" m ON s."metricId" = m.id
            LEFT JOIN "Products" p ON m."productId" = p.id
            WHERE 
                (:fromDate IS NULL OR s."createdAt" >= :fromDate)
                AND (:toDate IS NULL OR s."createdAt" <= :toDate)
                AND (:salesId IS NULL OR s."salesId" = :salesId)
                AND (:subAgentId IS NULL OR s."subAgentId" = :subAgentId)
                AND (:agentId IS NULL OR s."agentId" = :agentId)
                AND (s."status" = :status)
            GROUP BY p.id, m.id, p.image -- , s."totalPrice", s."agentPrice", s."subAgentPrice", s."salesmanPrice"
            ORDER BY p."name" ASC, "lastStockUpdate" DESC;
        `;

        const [results] = await sequelize.query(query, {
            replacements: {
                fromDate,
                toDate,
                status,
                salesId: reqSalesId,
                subAgentId: reqSubAgentId,
                agentId: reqAgentId
            }
        });

        res.json(results);
    } catch (error) {
        console.error("❌ Stock Table Error:", error);
        res.status(500).json({ error: "Failed to fetch stock table" });
    }
};


exports.getStockClientTable = async (req, res) => {
    const { fromDate, toDate, status, salesId, subAgentId, agentId, stockEvent, shopId } = req.query;

    // Ensure that optional parameters default to null if they are missing (undefined)
    // This ensures the replacements object will always have these keys defined.
    const reqSalesId = salesId || null;
    const reqSubAgentId = subAgentId || null;
    const reqAgentId = agentId || null;
    const reqShopId = shopId || null;
    const reqStockEvent = stockEvent || null;

    try {
        const query = `
            SELECT 
                s.id AS "stockId",
                p."name" AS "productName",
                p.image AS "image",
                m."metricType" AS "measurement",
                s."metricId",
                s."stockEvent",
                s."amount",
                s."updateAmount",
                s."totalPrice",
                s."totalNetPrice",
                s."agentPrice",
                s."subAgentPrice",
                s."salesmanPrice",
                s."totalDistributorShare",
                s."totalSalesShare",
                s."totalSubAgentShare",
                s."totalAgentShare",
                s."totalShopShare",
                s."status",
                s."description",
                s."createdBy",
                COALESCE(sa.name, ag.name, sm.name, sh.name, 'N/A') AS "relatedEntity",
                CASE 
                    WHEN s."salesId" IS NOT NULL THEN 'Salesman'
                    WHEN s."subAgentId" IS NOT NULL THEN 'SubAgent'
                    WHEN s."agentId" IS NOT NULL THEN 'Agent'
                    WHEN s."shopId" IS NOT NULL THEN 'Shop'
                    ELSE 'Unknown'
                END AS "entityType",
                sh."name" AS "shopName"
            FROM "Stocks" s
            LEFT JOIN "Metrics" m ON s."metricId" = m.id
            LEFT JOIN "Products" p ON m."productId" = p.id
            LEFT JOIN "Salesmans" sm ON s."salesId" = sm.id
            LEFT JOIN "SubAgents" sa ON s."subAgentId" = sa.id
            LEFT JOIN "Agents" ag ON s."agentId" = ag.id
            LEFT JOIN "Shops" sh ON s."shopId" = sh.id
            WHERE 
                s."status" = :status
                AND (:fromDate IS NULL OR s."createdAt" >= :fromDate)
                AND (:toDate IS NULL OR s."createdAt" <= :toDate)
                AND (:salesId IS NULL OR s."salesId" = :salesId)
                AND (:subAgentId IS NULL OR s."subAgentId" = :subAgentId)
                AND (:agentId IS NULL OR s."agentId" = :agentId)
                AND (:shopId IS NULL OR s."shopId" = :shopId)
                AND (:stockEvent IS NULL OR s."stockEvent" = :stockEvent)
            ORDER BY s."createdAt" DESC;
        `;

        const [results] = await sequelize.query(query, {
            replacements: {
                fromDate,
                toDate,
                status,
                salesId: reqSalesId,
                subAgentId: reqSubAgentId,
                agentId: reqAgentId,
                shopId: reqShopId,
                stockEvent: reqStockEvent
            }
        });

        res.json(results);
    } catch (error) {
        console.error("❌ Stock Table Error:", error);
        res.status(500).json({ error: "Failed to fetch stock table" });
    }
};


exports.settlingStock = async (req, res) => {
    try {
        const { id, metricId } = req.body;

        // Find stock entry with 'created' status
        let stock = await Stock.findOne({ where: { id, status: "created" } });

        if (!stock) {
            return res.status(404).json({ message: "Stock entry not found or already settled" });
        }

        let stockEvent = stock.stockEvent;
        let amount = stock.amount;
        let initialAmount = 0;
        const lastStock = await Stock.findOne({
            where: { metricId, status: "settled" },
            order: [["createdAt", "DESC"]]
        });

        if (lastStock) {
            initialAmount = lastStock.updateAmount ? lastStock.updateAmount : 0;
        }

        const updateAmount = stockEvent === 'stock_in' ? initialAmount + amount : initialAmount - amount;
        if (updateAmount < 0) return res.status(400).json({ message: 'Not enough stock' });

        // ✅ Fetch the latest price for this metric
        const latestPrice = await Price.findOne({ where: { metricId }, order: [["createdAt", "DESC"]] });
        if (!latestPrice) return res.status(400).json({ error: "No price available for this metric" });

        // ✅ Fetch percentage values
        const percentages = await Percentage.findAll();
        const percentageMap = {};
        percentages.forEach(p => { percentageMap[p.key] = p.value; });
        let distributorPercentage = 0;

        // ✅ Calculate stock values
        const totalPrice = amount * latestPrice.price;
        const totalNetPrice = totalPrice * (100 / percentageMap["supplier"]);

        let totalDistributorShare;
        let totalSalesShare = null;
        let totalSubAgentShare = null;
        let totalAgentShare = null;
        let totalShopShare = null;

        if (stock.salesId) {
            distributorPercentage = 100 - percentageMap["supplier"] - percentageMap["shop"] - percentageMap["salesman"];
            totalDistributorShare = totalNetPrice * distributorPercentage / 100;
            totalSalesShare = totalNetPrice * (percentageMap["salesman"] / 100);
        } else if (stock.subAgentId) {
            distributorPercentage = 100 - percentageMap["supplier"] - percentageMap["shop"] - percentageMap["subAgent"];
            totalDistributorShare = totalNetPrice * distributorPercentage / 100;
            totalSubAgentShare = totalNetPrice * (percentageMap["subAgent"] / 100);
        } else if (stock.agentId) {
            /// kalau agent, tidak perlu bagi ke shop
            distributorPercentage = 100 - percentageMap["supplier"] - percentageMap["agent"];
            totalDistributorShare = totalNetPrice * distributorPercentage / 100;
            // totalDistributorShare = totalNetPrice * (100 - percentageMap["supplier"] - percentageMap["shop"] - percentageMap["agent"]) / 100;

            totalAgentShare = totalNetPrice * (percentageMap["agent"] / 100);
        } else {
            totalDistributorShare = 0;
        }

        if (stockEvent === 'stock_out') {
            // ✅ Pastikan apakah shop commission selalu 20% (termasuk dari Agent).
            totalShopShare = totalNetPrice * (percentageMap["shop"] / 100);
        }

        // if (stockEvent === 'stock_out' && !stock.agentId) {
        //     totalShopShare = totalNetPrice * (percentageMap["shop"] / 100);
        // }

        // Update stock fields
        stock.status = "settled";
        stock.initialAmount = initialAmount;
        stock.updateAmount = updateAmount;
        stock.totalSalesShare = totalSalesShare;
        stock.totalDistributorShare = totalDistributorShare;
        stock.totalSubAgentShare = totalSubAgentShare;
        stock.totalAgentShare = totalAgentShare;
        stock.totalShopShare = totalShopShare;

        // Save updated stock entry
        await stock.save();

        if (stock.salesId) {

            // ✅ Store Commission in SALESMANCOMMISSIONS Table
            await SalesmanCommission.create({
                stockId: id,
                salesId: stock.salesId,
                percentage: percentageMap["salesman"],
                totalNetPrice,
                amount: totalSalesShare,
                createdBy: req.user.username
            });

        } else if (stock.subAgentId) {

            // ✅ Store Commission in SubAgentCommission Table
            await SubAgentCommission.create({
                stockId: id,
                subAgentId: stock.subAgentId,
                percentage: percentageMap["subAgent"],
                totalNetPrice,
                amount: totalSubAgentShare,
                createdBy: req.user.username
            });

        } else if (stock.agentId) {

            // ✅ Store Commission in AgentCommission Table
            await AgentCommission.create({
                stockId: id,
                agentId: stock.agentId,
                percentage: percentageMap["agent"],
                totalNetPrice,
                amount: totalAgentShare,
                createdBy: req.user.username
            });

        }

        if (totalDistributorShare) {
            // ✅ Store Distributor Commission in DistributorCommission Table
            await DistributorCommission.create({
                stockId: id,
                percentage: distributorPercentage,
                totalNetPrice,
                amount: totalDistributorShare,
                createdBy: req.user.username
            });
        }


        if (stock.salesId || stock.subAgentId || stock.agentId) {
            // ✅ Store All Shop Commission in ShopAllCommission Table
            await ShopAllCommission.create({
                stockId: id,
                salesId: stock.salesId,
                subAgentId: stock.subAgentId,
                agentId: stock.agentId,
                percentage: percentageMap["shop"],
                totalNetPrice,
                amount: totalShopShare,
                createdBy: req.user.username
            });

        }

        return res.status(200).json({ message: "Stock status updated successfully", stock });
    } catch (error) {
        console.error("Error updating stock status:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};


exports.cancelingStock = async (req, res) => {
    try {
        const { id, description } = req.body;

        // Find stock entry with 'created' status
        let stock = await Stock.findOne({ where: { id, status: "created" } });

        if (!stock) {
            return res.status(404).json({ message: "Stock entry not found or already settled" });
        }

        // Update stock fields
        stock.status = "canceled";
        stock.description = description;

        // Save updated stock entry
        await stock.save();

        return res.status(200).json({ message: "Stock status canceled successfully", stock });
    } catch (error) {
        console.error("Error canceling stock status:", error);
        return res.status(500).json({ message: "Internal server error" });
    }
};


exports.getStockResume = async (req, res) => {
    const { fromDate, toDate, salesId, subAgentId, agentId, shopId } = req.body;

    try {
        let whereClause = {
            createdAt: {
                [Op.between]: [new Date(fromDate), new Date(toDate)]
            }
        };
        if (salesId) {
            whereClause['salesId'] = salesId;
        }
        if (subAgentId) {
            whereClause['subAgentId'] = subAgentId;
        }
        if (agentId) {
            whereClause['agentId'] = agentId;
        }
        if (shopId) {
            whereClause['shopId'] = shopId;
        }


        const stockResume = await Stock.findAll({
            where: whereClause,
            attributes: [
                [sequelize.fn('SUM', sequelize.col('amount')), 'totalAmount'],
                [sequelize.fn('SUM', sequelize.col('salesmanPrice')), 'totalNetSalesman'],
                [sequelize.fn('SUM', sequelize.col('subAgentPrice')), 'totalNetSubAgent'],
                [sequelize.fn('SUM', sequelize.col('agentPrice')), 'totalNetAgent'],
                [sequelize.fn('SUM', sequelize.col('totalSalesShare')), 'totalSalesmanCommission'],
                [sequelize.fn('SUM', sequelize.col('totalSubAgentShare')), 'totalSubAgentCommission'],
                [sequelize.fn('SUM', sequelize.col('totalAgentShare')), 'totalAgentCommission'],
                [sequelize.fn('SUM', sequelize.col('totalShopShare')), 'totalShopAllCommission'],
                [sequelize.fn('SUM', sequelize.col('totalNetPrice')), 'totalNetPriceSum'],
            ],
            raw: true
        });

        // const salesmanCommissions = await SalesmanCommission.findAll({
        //     where: whereClause,
        //     attributes: [
        //         [sequelize.fn('SUM', sequelize.col('amount')), 'totalSalesmanCommission']
        //     ],
        //     raw: true
        // });

        // const shopAllCommissions = await ShopAllCommission.findAll({
        //     where: whereClause,
        //     attributes: [
        //         [sequelize.fn('SUM', sequelize.col('amount')), 'totalShopAllCommission']
        //     ],
        //     raw: true
        // });

        return res.status(200).json({
            totalAmount: stockResume[0]?.totalAmount || 0,
            totalNetPriceSum: stockResume[0]?.totalNetPriceSum || 0,
            totalNetSalesmanSum: stockResume[0]?.totalNetSalesman || 0,
            totalNetSubAgentSum: stockResume[0]?.totalNetSubAgent || 0,
            totalNetAgentSum: stockResume[0]?.totalNetAgent || 0,
            totalSalesmanCommission: stockResume[0]?.totalSalesmanCommission || 0,
            totalSubAgentCommission: stockResume[0]?.totalSubAgentCommission || 0,
            totalAgentCommission: stockResume[0]?.totalAgentCommission || 0,
            totalShopAllCommission: stockResume[0]?.totalShopAllCommission || 0
        });

    } catch (error) {
        console.error("❌ Stock Table Error:", error);
        res.status(500).json({ error: "Failed to fetch stock table" });
    }
};


exports.getTableBySalesId = async (req, res) => {
    const { fromDate, toDate, salesId } = req.body;

    try {
        const query = `
            SELECT 
                s.id,
                s.amount,
                s."agentPrice",
                s."subAgentPrice",
                s."salesmanPrice",
                s."totalSalesShare",
                s."totalSubAgentShare",
                s."totalAgentShare",
                -- s."totalNetPrice",
                s.status,
                s."updatedAt",
                p.name AS "productName",
                m."metricType",
                sh."name" AS "shopName"
                -- pr."netPrice",
                -- sc.amount AS "salesmanCommission",
                -- sac.amount AS "shopAllCommission"
            FROM "Stocks" s
            LEFT JOIN "Metrics" m ON s."metricId" = m.id
            LEFT JOIN "Products" p ON m."productId" = p.id
            LEFT JOIN "Shops" sh ON s."shopId" = sh.id
            --  LEFT JOIN (
            --      SELECT DISTINCT ON ("metricId") "metricId", "netPrice" 
            --      FROM "Prices" 
            --      ORDER BY "metricId", "createdAt" DESC
            --  ) pr ON m.id = pr."metricId"
            --  LEFT JOIN "SalesmanCommissions" sc ON s.id = sc."stockId"
            --  LEFT JOIN "ShopAllCommissions" sac ON s.id = sac."stockId"
            WHERE s."salesId" = :salesId
            AND s."createdAt" BETWEEN :fromDate AND :toDate
            ORDER BY s."createdAt" DESC
        `;

        const stocks = await sequelize.query(query, {
            replacements: {
                salesId,
                fromDate: new Date(fromDate),
                toDate: new Date(toDate)
            },
            type: sequelize.QueryTypes.SELECT
        });

        return res.status(200).json(stocks);

    } catch (error) {
        console.error("❌ Stock Table Error:", error);
        res.status(500).json({ error: "Failed to fetch stock table" });
    }
};



exports.getTableBySubAgentId = async (req, res) => {
    const { fromDate, toDate, subAgentId } = req.body;

    try {
        const query = `
            SELECT 
                s.id,
                s.amount,
                s."agentPrice",
                s."subAgentPrice",
                s."salesmanPrice",
                s."totalSalesShare",
                s."totalSubAgentShare",
                s."totalAgentShare",
                -- s."totalNetPrice",
                s.status,
                s."updatedAt",
                p.name AS "productName",
                m."metricType",
                sh."name" AS "shopName"
                -- pr."netPrice",
                -- sc.amount AS "salesmanCommission",
                -- sac.amount AS "shopAllCommission"
            FROM "Stocks" s
            LEFT JOIN "Metrics" m ON s."metricId" = m.id
            LEFT JOIN "Products" p ON m."productId" = p.id
            LEFT JOIN "Shops" sh ON s."shopId" = sh.id
            --  LEFT JOIN (
            --      SELECT DISTINCT ON ("metricId") "metricId", "netPrice" 
            --      FROM "Prices" 
            --      ORDER BY "metricId", "createdAt" DESC
            --  ) pr ON m.id = pr."metricId"
            --  LEFT JOIN "SalesmanCommissions" sc ON s.id = sc."stockId"
            --  LEFT JOIN "ShopAllCommissions" sac ON s.id = sac."stockId"
            WHERE s."subAgentId" = :subAgentId
            AND s."createdAt" BETWEEN :fromDate AND :toDate
            ORDER BY s."createdAt" DESC
        `;

        const stocks = await sequelize.query(query, {
            replacements: {
                subAgentId,
                fromDate: new Date(fromDate),
                toDate: new Date(toDate)
            },
            type: sequelize.QueryTypes.SELECT
        });

        return res.status(200).json(stocks);

    } catch (error) {
        console.error("❌ Stock Table Error:", error);
        res.status(500).json({ error: "Failed to fetch stock table" });
    }
};



exports.getTableByAgentId = async (req, res) => {
    const { fromDate, toDate, agentId } = req.body;

    try {
        const query = `
            SELECT 
                s.id,
                s.amount,
                s."agentPrice",
                s."subAgentPrice",
                s."salesmanPrice",
                s."totalSalesShare",
                s."totalSubAgentShare",
                s."totalAgentShare",
                -- s."totalNetPrice",
                s.status,
                s."updatedAt",
                p.name AS "productName",
                m."metricType",
                sh."name" AS "shopName"
                -- pr."netPrice",
                -- sc.amount AS "salesmanCommission",
                -- sac.amount AS "shopAllCommission"
            FROM "Stocks" s
            LEFT JOIN "Metrics" m ON s."metricId" = m.id
            LEFT JOIN "Products" p ON m."productId" = p.id
            LEFT JOIN "Shops" sh ON s."shopId" = sh.id
            --  LEFT JOIN (
            --      SELECT DISTINCT ON ("metricId") "metricId", "netPrice" 
            --      FROM "Prices" 
            --      ORDER BY "metricId", "createdAt" DESC
            --  ) pr ON m.id = pr."metricId"
            --  LEFT JOIN "SalesmanCommissions" sc ON s.id = sc."stockId"
            --  LEFT JOIN "ShopAllCommissions" sac ON s.id = sac."stockId"
            WHERE s."agentId" = :agentId
            AND s."createdAt" BETWEEN :fromDate AND :toDate
            ORDER BY s."createdAt" DESC
        `;

        const stocks = await sequelize.query(query, {
            replacements: {
                agentId,
                fromDate: new Date(fromDate),
                toDate: new Date(toDate)
            },
            type: sequelize.QueryTypes.SELECT
        });

        return res.status(200).json(stocks);

    } catch (error) {
        console.error("❌ Stock Table Error:", error);
        res.status(500).json({ error: "Failed to fetch stock table" });
    }
};



exports.getTableByShopId = async (req, res) => {
    const { fromDate, toDate, shopId } = req.body;

    try {
        const query = `
            SELECT 
                s.id,
                s.amount,
                s."agentPrice",
                s."subAgentPrice",
                s."salesmanPrice",
                s."totalSalesShare",
                s."totalSubAgentShare",
                s."totalAgentShare",
                s."totalNetPrice",
                s."totalShopShare",
                s.status,
                s."updatedAt",
                p.name AS "productName",
                m."metricType",
                sh."name" AS "shopName"
            FROM "Stocks" s
            LEFT JOIN "Metrics" m ON s."metricId" = m.id
            LEFT JOIN "Products" p ON m."productId" = p.id
            LEFT JOIN "Shops" sh ON s."shopId" = sh.id
            WHERE s."shopId" = :shopId
            AND s."createdAt" BETWEEN :fromDate AND :toDate
            ORDER BY s."createdAt" DESC
        `;

        const stocks = await sequelize.query(query, {
            replacements: {
                shopId,
                fromDate: new Date(fromDate),
                toDate: new Date(toDate)
            },
            type: sequelize.QueryTypes.SELECT
        });

        return res.status(200).json(stocks);

    } catch (error) {
        console.error("❌ Stock Table Error:", error);
        res.status(500).json({ error: "Failed to fetch stock table" });
    }
};



