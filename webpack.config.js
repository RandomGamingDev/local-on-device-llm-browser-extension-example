const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    index: path.resolve(__dirname, 'src/index.js'),
    background: path.resolve(__dirname, 'src/background.js'),
    main: path.resolve(__dirname, 'src/main.js'),
    offscreen: path.resolve(__dirname, 'src/offscreen.js')
  },
  output: {
    filename: 'src/[name].js',
    path: path.resolve(__dirname, 'dist'),
    clean: true,
  },
  mode: 'production',
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: 'manifest.json' },
        { from: 'src/popup.html', to: 'src/popup.html' },
        { from: 'src/offscreen.html', to: 'src/offscreen.html' },

        { from: 'resources', to: 'resources' },

        {
          from: 'node_modules/@mediapipe/tasks-genai/wasm',
          to: 'wasm',
          noErrorOnMissing: true
        }
      ],
    }),
  ],
  resolve: {
    extensions: ['.js'],
    fallback: {
      fs: false,
      path: false,
      crypto: false
    }
  },
  performance: {
    maxAssetSize: 100000000,
    maxEntrypointSize: 100000000,
  }
};