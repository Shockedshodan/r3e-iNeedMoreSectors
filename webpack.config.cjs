/*
 * Adapted from SealHUD webpack.config.js at
 * d38cdc53c5ac5b6781ebe7cdd6abb012e16bc79b.
 * Copyright (c) 2026 Diego Junges and contributors. MIT License.
 * See THIRD_PARTY_NOTICES.md for the preserved upstream notice.
 */
const path = require('node:path');
const fs = require('node:fs');
const { BannerPlugin, Compilation, sources } = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');

const thirdPartyNotices = {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap('ThirdPartyNotices', compilation => {
      compilation.hooks.processAssets.tap({
        name: 'ThirdPartyNotices', stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL,
      }, () => {
        const notices = fs.readFileSync(path.join(__dirname, 'THIRD_PARTY_NOTICES.md'), 'utf8');
        const sealHudLicense = fs.readFileSync(path.join(__dirname, 'LICENSES/SealHUD-MIT.txt'), 'utf8');
        compilation.emitAsset('THIRD_PARTY_NOTICES.txt', new sources.RawSource(`${notices}\n\n${sealHudLicense}`));
      });
    });
  },
};

module.exports = function createWebpackConfig(env = {}, argv = {}) {
  const mode = argv.mode || 'development';
  return {
    mode,
    context: __dirname,
    target: ['web', 'es2018'],
    entry: env.entry || path.join(__dirname, 'src/browser.tsx'),
    devtool: 'source-map',
    output: {
      filename: 'app.js',
      path: env.outputPath || path.join(__dirname, 'dist'),
      clean: true,
      publicPath: 'auto',
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
      extensionAlias: { '.js': ['.js', '.ts', '.tsx'] },
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          use: {
            loader: 'ts-loader',
            options: { configFile: path.join(__dirname, 'tsconfig.web.json'), transpileOnly: true },
          },
        },
        { test: /\.css$/i, use: ['style-loader', 'css-loader'] },
        {
          test: /\.(png|jpe?g|gif|svg|woff2?|ttf|wav|cur)$/i,
          type: 'asset/resource',
          generator: { filename: 'files/[name][ext]' },
        },
      ],
    },
    plugins: [
      thirdPartyNotices,
      // Add the pointer after minification so a standalone distributed bundle
      // retains its attribution link even when source comments are extracted.
      new BannerPlugin({
        banner: 'SealHUD-derived portions: Copyright (c) 2026 Diego Junges and contributors. MIT License; see THIRD_PARTY_NOTICES.txt.',
        entryOnly: true,
        stage: Compilation.PROCESS_ASSETS_STAGE_REPORT,
      }),
      ...(env.html === false ? [] : [new HtmlWebpackPlugin({
        template: path.join(__dirname, 'src/index.html'),
        minify: mode === 'production' ? { collapseWhitespace: true, removeComments: true } : false,
      })]),
    ],
    devServer: {
      static: path.join(__dirname, 'dist'),
      host: '127.0.0.1',
      port: Number(env.port || process.env.PORT || 3000),
      open: false,
      hot: true,
    },
  };
};
