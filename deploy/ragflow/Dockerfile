FROM infiniflow/ragflow:v0.26.4@sha256:16d24d1968ab59e2715a85d2590f1569c9539e0362344a42f3a23e8be06a655b

COPY deploy/ragflow/secret-entrypoint.sh /usr/local/bin/aegis-ragflow-entrypoint
RUN chmod 0555 /usr/local/bin/aegis-ragflow-entrypoint

ENTRYPOINT ["/usr/local/bin/aegis-ragflow-entrypoint"]
