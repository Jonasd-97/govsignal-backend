const winston = require("winston");

const logger = winston.createLogger({
  level: process.env.NODE_ENV === "production" ? "info" : "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    process.env.NODE_ENV === "production"
      ? winston.format.json()
      : winston.format.combine(
          winston.format.colorize(),
          winston.format.printf(({ timestamp, level, message, ...rest }) =>
            `${timestamp} [${level}]: ${message} ${Object.keys(rest).length ? JSON.stringify(rest) : ""}`
          )
        )
  ),
  transports: [
    new winston.transports.Console(),
    ...(process.env.NODE_ENV === "production"
      ? [new winston.transports.File({ filename: "logs/error.log", level: "error" }),
         new winston.transports.File({ filename: "logs/combined.log" })]
      : []),
  ],
});

module.exports = logger;
