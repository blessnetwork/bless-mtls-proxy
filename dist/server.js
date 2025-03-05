"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fastify_1 = __importDefault(require("fastify"));
const index_1 = __importDefault(require("./src/index"));
const app = (0, fastify_1.default)({ logger: true });
app.register(index_1.default, {});
app.listen(3000, (err, address) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
});
