const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User } = require("../models");
const logger = require('../config/logger');

exports.register = async (req, res) => {
    try {
        const { username, password, name, email, phone, address, level, updateBy } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);

        const existingUser = await User.findOne({ where: { username } });
        if (existingUser) return res.status(400).json({ message: 'Username already exists' });

        await User.create({
            username,
            password: hashedPassword,
            name,
            email,
            phone,
            address,
            level,
            updateBy
        });

        res.status(200).json({ message: 'User registered successfully' });
    } catch (error) {
        logger.error(error.message, { stack: error.stack });
        res.status(500).json({ message: 'Error registering user', error: error.message });
    }
};

exports.login = async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ where: { username } });

        if (!user || !bcrypt.compareSync(password, user.password)) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        // Generate tokens
        const accessToken = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '1h' });
        const refreshToken = jwt.sign({ id: user.id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });

        // Store refresh token in DB
        user.refreshToken = refreshToken;
        await user.save();

        logger.info("✅ User " + username + " login successfully.");

        res.json({ accessToken, refreshToken });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
};


exports.refreshToken = async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) return res.status(403).json({ message: 'Refresh token required' });

        // Find user with this refresh token
        const user = await User.findOne({ where: { refreshToken } });
        if (!user) return res.status(403).json({ message: 'Invalid refresh token' });

        // Verify token
        jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET, (err, decoded) => {
            if (err) return res.status(403).json({ message: 'Token expired or invalid' });

            const newAccessToken = jwt.sign({ id: decoded.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '15m' });
            res.json({ accessToken: newAccessToken });
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
};


exports.logout = async (req, res) => {
    try {
        const { refreshToken } = req.body;
        if (!refreshToken) return res.status(400).json({ message: 'Refresh token required' });

        // Remove refresh token from DB
        const user = await User.findOne({ where: { refreshToken } });
        if (!user) return res.status(403).json({ message: 'Invalid refresh token' });

        user.refreshToken = null;
        await user.save();

        res.json({ message: 'Logged out successfully' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
};
