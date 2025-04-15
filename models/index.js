// models/index.js

'use strict';

const fs = require('fs');
const path = require('path');
const Sequelize = require('sequelize');
const basename = path.basename(__filename);
const db = {};

// --- Import the Sequelize instance from config/db.js ---
const sequelize = require('../config/db');
// --- End of import ---

// --- Load models ---
fs
    .readdirSync(__dirname)
    .filter(file => {
        return (
            file.indexOf('.') !== 0 &&
            file !== basename &&
            file.slice(-3) === '.js' &&
            file.indexOf('.test.js') === -1
        );
    })
    .forEach(file => {
        // Ensure models are defined correctly, passing the imported sequelize instance
        const model = require(path.join(__dirname, file))(sequelize, Sequelize.DataTypes);
        db[model.name] = model;
    });
// --- End of loading models ---

// --- Setup associations ---
Object.keys(db).forEach(modelName => {
    if (db[modelName].associate) {
        db[modelName].associate(db);
    }
});
// --- End of associations ---

db.sequelize = sequelize; // The configured Sequelize instance
db.Sequelize = Sequelize; // The Sequelize library itself

module.exports = db;