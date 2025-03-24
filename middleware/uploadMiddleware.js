const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");

// ✅ Configure multer to store image in memory buffer (instead of disk)
const storage = multer.memoryStorage();

// ✅ File filter for images only
const fileFilter = (req, file, cb) => {
    console.log("apa ini...???", file);
    if (file.mimetype.startsWith("image/")) {
        cb(null, true);
    } else {
        cb(new Error("Only image files are allowed"), false);
    }
};

// ✅ Multer upload instance
const upload = multer({ storage, fileFilter });

// ✅ Image Compressor Middleware
const imageCompressor = async (req, res, next) => {
    if (!req.file) return next(); // Skip if no file uploaded

    const filename = `${Date.now()}-${req.file.originalname.replace(/\s+/g, '-')}`;
    const outputPath = path.join(__dirname, '../uploads', filename);

    try {
        await sharp(req.file.buffer)
            .resize({ width: 800 }) // Resize to 800px width
            .jpeg({ quality: 70 }) // Compress to 70% quality
            .toFile(outputPath); // Save compressed image to 'uploads' folder

        req.imagePath = `/uploads/${filename}`; // ✅ Pass image path to the controller
        next();
    } catch (error) {
        console.error("❌ Image Compression Error:", error);
        return res.status(500).json({ error: "Failed to compress image" });
    }
};

module.exports = { upload, imageCompressor };
