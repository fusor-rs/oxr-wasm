//! The OXR page. The image chosen, the task, reading and its live measurements are signals here;
//! `web/app.js` decodes the image, runs the engine worker and reports back through `engine`
//! events.

mod answer;
mod app;
