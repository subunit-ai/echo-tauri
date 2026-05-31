use criterion::{criterion_group, criterion_main, Criterion};
use std::collections::HashMap;
use std::hint::black_box;

use echo_lib::auto_mode::pick_style;

fn bench_pick_style(c: &mut Criterion) {
    let mut overrides = HashMap::new();
    for i in 0..100 {
        // Now overrides have lowercased keys because we expect config to have them lowercased
        overrides.insert(format!("someapp{}", i), "custom".to_string());
    }

    c.bench_function("pick_style_overrides", |b| {
        b.iter(|| {
            pick_style(
                black_box("This is SomeApp50 Title"),
                black_box(&overrides),
                black_box("default"),
            );
        })
    });

    c.bench_function("pick_style_curated", |b| {
        b.iter(|| {
            pick_style(
                black_box("This is visual studio code"),
                black_box(&overrides),
                black_box("default"),
            );
        })
    });
}

criterion_group!(benches, bench_pick_style);
criterion_main!(benches);
