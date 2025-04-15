const express = require("express");
const {  getAllUsers } = require("../controllers/userController");
const authMiddleware = require("../middleware/authMiddleware");

const router = express.Router();

router.get("/users", authMiddleware, getAllUsers);

module.exports = router;
