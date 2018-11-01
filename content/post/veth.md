---
title: "Creating vEth pairs for network emulation"
date: 2018-10-30T15:01:11Z
draft: true
---

Mininet is group of names spaces connected together by veth pairs to create a virtual network environment. It includes virtual OpenFlow switches, and virtual nodes.
<h1>External nodes</h1>
Sometimes you might want to run an experiment that requires connectivity with the host machine or another external machine. As they are both logically different namespaces, by default, they cannot communicate with each other.
<h1>veth pairs</h1>
Creates a pair of virtual interfaces in linux that are connected together. Think of this as a pipe - a packet goes in one end, it comes out of the other.
<h1>Guide</h1>
Create veth pair using ip command

In mininet, use the Inf library in your mininet script to allow a host to steal an interface. Pick one of the new interfaces that was created (e.g. vEth0).

Run the script
<h2>Testing</h2>
Ping each other. Okay, run Iperf or simple websever

Connectivity!
<h2>Explanation</h2>
So what happened? (Use diagram to explain)
