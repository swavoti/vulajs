const path = require('path');
const { defineConfig } = require('@rspack/cli');
const { ReactRefreshRspackPlugin } = require('@rspack/plugin-react-refresh');
const rspack = require('@rspack/core');

module.exports = defineConfig({
  entry: {
    main: ['webpack-hot-middleware/client?path=/__webpack_hmr&reload=true', './src/index.tsx'], // Client Entry with HMR
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    alias: {
      '@app': path.resolve(__dirname, 'app'),
    },
  },
  module: {
    rules: [
      {
        test: /\.(j|t)sx?$/,
        exclude: [/[\\/]node_modules[\\/]/],
        use: [
          {
            loader: 'babel-loader',
            options: {
              plugins: [['babel-plugin-react-compiler', { target: '19' }]],
            },
          },
          {
            loader: 'builtin:swc-loader',
            options: {
              jsc: {
                parser: { syntax: 'typescript', tsx: true },
                transform: { react: { runtime: 'automatic', refresh: true } },
              },
            },
          },
        ],
        type: 'javascript/auto',
      },
      {
        test: /\.css$/,
        type: 'css',
      },
    ],
  },
  plugins: [
    new ReactRefreshRspackPlugin(),
    new rspack.HtmlRspackPlugin({
      template: './index.html',
    }),
  ],
  devServer: {
    port: 3000,
    hot: true,
    historyApiFallback: true,
    static: {
      directory: path.join(__dirname, 'public'),
    },
  },
  output: {
    clean: true,
    path: path.resolve(__dirname, '.swvula'),
    filename: '.vula.cache.js',
    chunkFilename: 'chunks/vula-[name].js',
    publicPath: '/',
  },
  optimization: {
    minimize: process.env.NODE_ENV === 'production',
    minimizer: [
      new rspack.SwcJsMinimizerRspackPlugin({
        test: /^\.vula\.cache\.js$/,
        minimizerOptions: {
          compress: { passes: 3 },
          mangle: true,
          format: { comments: false },
        },
      }),
      new rspack.LightningCssMinimizerRspackPlugin(),
    ],
    splitChunks: false,
    chunkIds: 'named',
  },
});
