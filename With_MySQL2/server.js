import "@babel/polyfill";
import dotenv from "dotenv";
import "isomorphic-fetch";
import createShopifyAuth, { verifyRequest } from "@shopify/koa-shopify-auth";
import Shopify, { ApiVersion } from "@shopify/shopify-api";
import Koa from "koa";
import next from "next";
import Router from "koa-router";
import {storeCallback, loadCallback, deleteCallback} from "./custom-session";
import mysql from "mysql2";


dotenv.config();
const port = parseInt(process.env.PORT, 10) || 8081;
const dev = process.env.NODE_ENV !== "production";
const app = next({
  dev,
});
const handle = app.getRequestHandler();

Shopify.Context.initialize({
  API_KEY: process.env.SHOPIFY_API_KEY,
  API_SECRET_KEY: process.env.SHOPIFY_API_SECRET,
  SCOPES: process.env.SCOPES.split(","),
  HOST_NAME: process.env.HOST.replace(/https:\/\/|\/$/g, ""),
  API_VERSION: ApiVersion.October20,
  IS_EMBEDDED_APP: true,
  // This should be replaced with your preferred storage strategy
  SESSION_STORAGE: new Shopify.Session.CustomSessionStorage(
    storeCallback,
    loadCallback,
    deleteCallback
  ),
});

// Connecting to mysql //
let conn = mysql.createPool({
  host: `${process.env.DATABASE_HOST}`,
  user: `${process.env.DATABASE_USER}`,
  password: `${process.env.DATABASE_PASSWORD}`,
  database: `${process.env.DATABASE_DB}`,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});
// End of connecting to mysql //

// Storing the currently active shops in memory will force them to re-login when your server restarts. You should
// persist this object in your app.

app.prepare().then(async () => {
  const server = new Koa();
  const router = new Router();
  server.keys = [Shopify.Context.API_SECRET_KEY];
  server.use(
    createShopifyAuth({
      async afterAuth(ctx) {
        // Access token and shop available in ctx.state.shopify
        const { shop, accessToken, scope } = ctx.state.shopify;
        const host = ctx.query.host;

        // Getting our current user //
        let user = new Promise((resolve, reject) => {
          conn.query("SELECT `shop`, `accessToken`, `scope` FROM "+`${process.env.DATABASE_SESSION_STORAGE_TABLE}`+" WHERE `shop`= ? LIMIT 1", [shop], function(error, results, fields) {
            if (error) throw error;
            resolve(results[0]);
          });
        });
        user = await user;
        console.log("---------- USER ------------");
        console.log(user);
        console.log("---------- /USER ------------");
        // End of Getting our current user //

        const response = await Shopify.Webhooks.Registry.register({
          shop,
          accessToken,
          path: "/webhooks",
          topic: "APP_UNINSTALLED",
          webhookHandler: async (topic, shop, body) => {
            let deleteQuery = new Promise((resolve, reject) => {
              conn.query("DELETE FROM `shopify_session_storage` WHERE `shop`= ?", [shop], function(error, results, fields) {
                if (error) throw error;
                resolve(results);
              });
            });

            await deleteQuery;
            console.log("Webhook for uninstalled app: ", deleteQuery);
          }
        });

        if (!response.success) {
          console.log(
            `Failed to register APP_UNINSTALLED webhook: ${response.result}`
          );
        }

        // Redirect to app with shop parameter upon auth
        ctx.redirect(`/?shop=${shop}&host=${host}`);
      },
    })
  );

  const handleRequest = async (ctx) => {
    await handle(ctx.req, ctx.res);
    ctx.respond = false;
    ctx.res.statusCode = 200;
  };

  router.post("/webhooks", async (ctx) => {
    try {
      await Shopify.Webhooks.Registry.process(ctx.req, ctx.res);
      console.log(`Webhook processed, returned status code 200`);
    } catch (error) {
      console.log(`Failed to process webhook: ${error}`);
    }
  });

  router.post(
    "/graphql",
    verifyRequest({ returnHeader: true }),
    async (ctx, next) => {
      await Shopify.Utils.graphqlProxy(ctx.req, ctx.res);
    }
  );

  router.get("(/_next/static/.*)", handleRequest); // Static content is clear
  router.get("/_next/webpack-hmr", handleRequest); // Webpack content is clear
  router.get("(.*)", async (ctx) => {
    const shop = ctx.query.shop;
    // Getting our current user //
    let user = new Promise((resolve, reject) => {
      conn.query("SELECT `shop`, `accessToken`, `scope` FROM "+`${process.env.DATABASE_SESSION_STORAGE_TABLE}`+" WHERE `shop`= ? LIMIT 1", [shop], function(error, results, fields) {
        if (error) throw error;
        resolve(results[0]);
      });
    });
    user = await user;
    console.log("---------- USER ------------");
    console.log(user);
    console.log("---------- /USER ------------");
    // End of Getting our current user //
    // This shop hasn't been seen yet, go through OAuth to create a session
    if (user == null || user.shop == undefined) {
      ctx.redirect(`/auth?shop=${shop}`);
    } else {
      await handleRequest(ctx);
    }
  });

  server.use(router.allowedMethods());
  server.use(router.routes());
  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
});
