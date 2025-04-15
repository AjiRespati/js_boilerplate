const { User, Salesman, SubAgent, Agent } = require('../models');
const logger = require('../config/logger');

exports.getAllUsers = async (req, res) => {
    try {
        let data = await User.findAll({
            order: [["createdAt", "DESC"]]
        });

        data.forEach(el => {
            el['password'] = undefined;
        });

        res.json(data);
    } catch (error) {
        logger.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

exports.getUserById = async (req, res) => {
    try {
        const data = await User.findByPk(req.params.id);
        if (!data) return res.status(404).json({ error: 'user not found' });
        res.json(data);
    } catch (error) {
        logger.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

exports.createUser = async (req, res) => {
    try {
        const data = await User.create(req.body);
        res.status(200).json(data);
    } catch (error) {
        logger.error(error);
        res.status(400).json({ error: 'Bad Request' });
    }
};

exports.updateUser = async (req, res) => {
    try {
        const { id } = req.params;
        const { level, status } = req.body;

        // 1. find user by id
        const existingUser = await User.findByPk(id);
        if (!existingUser) return res.status(404).json({ error: 'user not found' });

        const { name, image, address, phone, email } = existingUser;

        existingUser.level = level || existingUser.level;
        existingUser.status = status || existingUser.status;

        // 2. Find if already sign as Salesman
        const existingSales = await Salesman.findOne({
            where: { email }
        })

        // 3. Find if already sign as SubAgent
        const existingSubAgent = await SubAgent.findOne({
            where: { email }
        })

        // 2. Find if already sign as Agent
        const existingAgent = await Agent.findOne({
            where: { email }
        })

        // If process is update level
        if (level !== null && level !== undefined) {

            // update level decription
            existingUser.levelDesc = levelDescList[level];

            switch (level) {
                // if update to Salesman
                case 1:
                    if (existingSubAgent) {
                        existingSubAgent.status = "inactive"
                        await existingSubAgent.save();
                        // await SubAgent.destroy({
                        //     where: { email }
                        // });
                    }

                    if (existingAgent) {
                        existingAgent.status = "inactive"
                        await existingAgent.save();

                        // await Agent.destroy({
                        //     where: { email }
                        // });
                    }

                    if (existingSales) {
                        existingSales.status = "active"
                        await existingSales.save();
                    } else {
                        await Salesman.create({ name, image, address, phone, email, updateBy: req.user.username });
                        logger.info(`Salesman created`);
                    }

                    break;

                case 2:
                    if (existingSales) {
                        existingSales.status = "inactive"
                        await existingSales.save();
                        // await Salesman.destroy({
                        //     where: { email }
                        // });
                    }

                    if (existingAgent) {
                        existingAgent.status = "inactive"
                        await existingAgent.save();
                        // await Agent.destroy({
                        //     where: { email }
                        // });
                    }

                    if (existingSubAgent) {
                        existingSubAgent.status = "active"
                        await existingSubAgent.save();
                    } else {
                        await SubAgent.create({ name, image, address, phone, email, updateBy: req.user.username });
                        logger.info(`SubAgent created`);
                    }

                    break;


                case 3:
                    if (existingSales) {
                        existingSales.status = "inactive"
                        await existingSales.save();
                        // await Salesman.destroy({
                        //     where: { email }
                        // });
                    }

                    if (existingSubAgent) {
                        existingSubAgent.status = "inactive"
                        await existingSubAgent.save();
                        // await SubAgent.destroy({
                        //     where: { email }
                        // });
                    }

                    if (existingAgent) {
                        existingAgent.status = "active"
                        await existingAgent.save();
                        // await Agent.destroy({
                        //     where: { email }
                        // });                        
                    } else {
                        await Agent.create({ name, image, address, phone, email, updateBy: req.user.username });
                        logger.info(`Agent created`);
                    }

                    break;

                default:
                    break;
            }
        }

        await existingUser.save();
        logger.info(`User updated: ${id}`);

        res.json(existingUser);
    } catch (error) {
        logger.error(error);
        res.status(400).json({ error: 'Bad Request' });
    }
};

exports.deleteUser = async (req, res) => {
    try {
        const data = await User.findByPk(req.params.id);
        if (!data) return res.status(404).json({ error: 'user not found' });

        await data.destroy();
        res.json({ message: 'user deleted successfully' });
    } catch (error) {
        logger.error(error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

const levelDescList = [
    "New User",
    "Salesman",
    "Sub Agent",
    "Agent",
    "Admin",
    "Owner",
];