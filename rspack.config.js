const path = require('path');
const { defineConfig } = require('@rspack/cli');
const { ReactRefreshRspackPlugin } = require('@rspack/plugin-react-refresh');
const rspack = require('@rspack/core');

module.exports = defineConfig({
  entry: {
    main: './src/index.tsx', // Client Entry
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
        loader: 'builtin:swc-loader',
        options: {
          jsc: {
            parser: {
              syntax: 'typescript',
              tsx: true,
            },
            transform: {
              react: {
                runtime: 'automatic',
                refresh: true,
              },
            },
          },
        },
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
    path: path.resolve(__dirname, 'dist'),
  },
});
