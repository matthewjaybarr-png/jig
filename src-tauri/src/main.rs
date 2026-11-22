// no console window behind Jig on Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    jig_lib::run()
}
