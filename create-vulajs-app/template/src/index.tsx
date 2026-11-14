import './vula.app.css';
import { bootstrapVula } from '@swavoti/vula/client';
import Layout from '../app/layout';

bootstrapVula({
  Layout,
  loadRoute: (clientPath: string) =>
    import(/* webpackInclude: /page\.(tsx|jsx)$/ */ `@app/${clientPath}`),
});
