// 参数化业务终端外壳。打印前必须用实际板卡复核尺寸。
$fn = 48;
board = [68, 42, 18];
wall = 2.4;
clearance = 1.2;
outer = [board.x + 2*(wall+clearance), board.y + 2*(wall+clearance), board.z + wall + 4];

module shell() {
  difference() {
    cube(outer, center=true);
    translate([0,0,wall]) cube([outer.x-2*wall, outer.y-2*wall, outer.z], center=true);
    translate([outer.x/2,0,1]) rotate([0,90,0]) cylinder(h=wall*3,d=10,center=true); // 摄像头/线缆
    translate([-outer.x/2,0,-3]) cube([wall*3,14,8],center=true); // USB
    for(x=[-18,-6,6,18]) translate([x,outer.y/2,4]) rotate([90,0,0]) cylinder(h=wall*3,d=2.2,center=true);
  }
}
shell();
