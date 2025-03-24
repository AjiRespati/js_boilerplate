
module.exports = (sequelize, DataTypes) => {
    const User = sequelize.define('User', {
        id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        username: { type: DataTypes.STRING, allowNull: false, unique: true },
        password: { type: DataTypes.STRING, allowNull: false },
        refreshToken: { type: DataTypes.TEXT, allowNull: true },
        name: { type: DataTypes.STRING, allowNull: false },
        image: { type: DataTypes.STRING, allowNull: true },
        address: { type: DataTypes.STRING, allowNull: true },
        phone: { type: DataTypes.STRING, allowNull: true, unique: true },
        email: { type: DataTypes.STRING, allowNull: true, unique: true },
        level: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
        updateBy: { type: DataTypes.STRING, allowNull: false }
    }, { timestamps: true });

    User.associate = (models) => {
        // Define associations here if needed
    };

    return User;
};
