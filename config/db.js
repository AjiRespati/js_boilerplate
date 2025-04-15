const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PASS, {
    host: process.env.DB_HOST,
    dialect: 'postgres',
    timezone: 'UTC', // Ensures Sequelize stores timestamps as UTC
    logging: console.log
});

module.exports = sequelize;
