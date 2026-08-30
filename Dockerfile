FROM scratch
ADD rootfs.tar.gz /

LABEL maintainer="Hasan <https://github.com/SwiftExplorer567>" \
      description="ImmortalWrt Modern Gateway Edition (OpenClash + Mihomo + WireGuard + Argon)" \
      org.opencontainers.image.source="https://github.com/SwiftExplorer567/immortalwrt-docker"

EXPOSE 80 443 22 7890 7891 7892 7893 7895 9090 9999
USER root
ENTRYPOINT ["/sbin/init"]
