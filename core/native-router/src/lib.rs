use napi_derive::napi;
use std::collections::HashMap;

#[napi]
pub fn match_route(route_path: String, active_path: String) -> Option<HashMap<String, String>> {
    let clean_route = if route_path.ends_with('/') && route_path != "/" {
        &route_path[..route_path.len() - 1]
    } else {
        &route_path
    };

    let clean_active = if active_path.ends_with('/') && active_path != "/" {
        &active_path[..active_path.len() - 1]
    } else {
        &active_path
    };

    let route_segs: Vec<&str> = clean_route.split('/').collect();
    let active_segs: Vec<&str> = clean_active.split('/').collect();

    if route_segs.len() != active_segs.len() {
        return None;
    }

    let mut params = HashMap::new();

    for i in 0..route_segs.len() {
        let route_seg = route_segs[i];
        let active_seg = active_segs[i];

        if route_seg == active_seg {
            continue;
        }

        if route_seg.starts_with('[') && route_seg.ends_with(']') {
            let param_name = route_seg[1..route_seg.len() - 1].to_string();
            params.insert(param_name, active_seg.to_string());
        } else {
            return None;
        }
    }

    Some(params)
}
